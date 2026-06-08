from __future__ import annotations

import asyncio
import heapq
import itertools
import time
from collections import defaultdict, deque
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any


JobFn = Callable[[], Awaitable[Any]]

PRIORITIES = {
    "protection": 1,
    "monitor": 1,
    "reconciliation": 2,
    "inference": 3,
    "market": 3,
    "normal": 4,
    "entry": 4,
    "training": 5,
    "low": 6,
    "analytics": 6,
    "retention": 6,
}


def _percentile(values: deque[float], percentile: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, int((len(ordered) - 1) * percentile)))
    return round(ordered[index], 2)


@dataclass
class RuntimeJob:
    name: str
    fn: JobFn
    interval_seconds: float
    timeout_seconds: float
    priority: str = "normal"
    enabled: bool = True
    run_immediately: bool = True
    retry_budget: int = 0
    lock_key: str | None = None
    consecutive_failures: int = 0
    runs: int = 0
    failures: int = 0
    skipped: int = 0
    rejected: int = 0
    retries: int = 0
    last_started_at: float = 0.0
    last_finished_at: float = 0.0
    last_duration_ms: float = 0.0
    last_queue_ms: float = 0.0
    last_error: str | None = None
    running: bool = False


@dataclass(order=True)
class QueuedWork:
    priority: int
    sequence: int
    name: str = field(compare=False)
    fn: JobFn = field(compare=False)
    timeout_seconds: float = field(compare=False)
    enqueued_at: float = field(compare=False)
    deadline_at: float = field(compare=False)
    future: asyncio.Future = field(compare=False)
    lock_key: str | None = field(compare=False, default=None)
    retry_budget: int = field(compare=False, default=0)


@dataclass
class JobSupervisor:
    max_concurrent_jobs: int = 3
    stale_after_seconds: float = 120.0
    max_queue_size: int = 256
    reserved_priority: int = 3
    latency_sample_size: int = 2048
    jobs: dict[str, RuntimeJob] = field(default_factory=dict)
    _tasks: list[asyncio.Task] = field(default_factory=list)
    _workers: list[asyncio.Task] = field(default_factory=list)
    _queue: list[QueuedWork] = field(default_factory=list)
    _queue_condition: asyncio.Condition | None = None
    _sequence: Any = field(default_factory=itertools.count)
    _active_locks: set[str] = field(default_factory=set)
    _queued_locks: set[str] = field(default_factory=set)
    _active_by_priority: dict[int, int] = field(default_factory=lambda: defaultdict(int))
    _submitted: int = 0
    _completed: int = 0
    _failed: int = 0
    _timed_out: int = 0
    _rejected: int = 0
    _preempted: int = 0
    _deduplicated: int = 0
    _expired: int = 0
    _retried: int = 0
    _queue_latency_ms: deque[float] = field(default_factory=deque)
    _run_latency_ms: deque[float] = field(default_factory=deque)
    _started_at: float = field(default_factory=time.time)
    _stopping: bool = False

    def register(
        self,
        name: str,
        fn: JobFn,
        interval_seconds: float,
        timeout_seconds: float,
        *,
        priority: str = "normal",
        run_immediately: bool = True,
        enabled: bool = True,
        retry_budget: int = 0,
        lock_key: str | None = None,
    ) -> None:
        if priority not in PRIORITIES:
            raise ValueError(f"Unknown job priority: {priority}")
        self.jobs[name] = RuntimeJob(
            name=name,
            fn=fn,
            interval_seconds=max(0.1, float(interval_seconds)),
            timeout_seconds=max(0.1, float(timeout_seconds)),
            priority=priority,
            run_immediately=run_immediately,
            enabled=enabled,
            retry_budget=max(0, int(retry_budget)),
            lock_key=lock_key,
        )

    def start(self) -> None:
        self._stopping = False
        if self._queue_condition is None:
            self._queue_condition = asyncio.Condition()
        worker_count = max(2, int(self.max_concurrent_jobs))
        for index in range(worker_count):
            if index >= len(self._workers) or self._workers[index].done():
                reserved = index == 0
                self._workers.append(
                    asyncio.create_task(
                        self._worker(reserved=reserved),
                        name=f"priority-worker:{index}",
                    )
                )
        for job in self.jobs.values():
            if job.enabled and not any(t.get_name() == f"job:{job.name}" for t in self._tasks):
                self._tasks.append(asyncio.create_task(self._runner(job), name=f"job:{job.name}"))

    async def stop(self) -> None:
        self._stopping = True
        for task in [*self._tasks, *self._workers]:
            task.cancel()
        for task in [*self._tasks, *self._workers]:
            try:
                await task
            except asyncio.CancelledError:
                pass
        self._tasks.clear()
        self._workers.clear()
        for work in self._queue:
            if not work.future.done():
                work.future.cancel()
        self._queue.clear()
        self._queued_locks.clear()

    async def execute(
        self,
        name: str,
        fn: JobFn,
        *,
        priority: str = "normal",
        timeout_seconds: float = 30.0,
        queue_timeout_seconds: float | None = None,
        lock_key: str | None = None,
        retry_budget: int = 0,
    ) -> Any:
        if priority not in PRIORITIES:
            raise ValueError(f"Unknown job priority: {priority}")
        if self._stopping:
            raise RuntimeError("job supervisor is stopping")
        if not self._workers:
            self.start()

        numeric_priority = PRIORITIES[priority]
        now = time.monotonic()
        queue_timeout = (
            max(0.01, float(queue_timeout_seconds))
            if queue_timeout_seconds is not None
            else max(30.0, float(timeout_seconds))
        )
        loop = asyncio.get_running_loop()
        future = loop.create_future()

        condition = self._queue_condition
        if condition is None:
            condition = asyncio.Condition()
            self._queue_condition = condition

        async with condition:
            if lock_key and (lock_key in self._active_locks or lock_key in self._queued_locks):
                self._deduplicated += 1
                raise RuntimeError(f"job lock already held: {lock_key}")
            if len(self._queue) >= max(1, self.max_queue_size):
                if numeric_priority <= self.reserved_priority:
                    candidates = [
                        (queued.priority, queued.sequence, index)
                        for index, queued in enumerate(self._queue)
                        if queued.priority > self.reserved_priority
                    ]
                    if candidates:
                        _, _, index = max(candidates)
                        evicted = self._queue[index]
                        last = self._queue.pop()
                        if index < len(self._queue):
                            self._queue[index] = last
                            heapq.heapify(self._queue)
                        if evicted.lock_key:
                            self._queued_locks.discard(evicted.lock_key)
                        if not evicted.future.done():
                            evicted.future.set_exception(
                                RuntimeError("preempted by critical priority work")
                            )
                        self._preempted += 1
                    else:
                        self._rejected += 1
                        raise RuntimeError("job queue is full")
                else:
                    self._rejected += 1
                    raise RuntimeError("job queue is full")

            work = QueuedWork(
                priority=numeric_priority,
                sequence=next(self._sequence),
                name=name,
                fn=fn,
                timeout_seconds=max(0.01, float(timeout_seconds)),
                enqueued_at=now,
                deadline_at=now + queue_timeout,
                future=future,
                lock_key=lock_key,
                retry_budget=max(0, int(retry_budget)),
            )
            heapq.heappush(self._queue, work)
            if lock_key:
                self._queued_locks.add(lock_key)
            self._submitted += 1
            condition.notify_all()

        return await future

    async def _runner(self, job: RuntimeJob) -> None:
        if not job.run_immediately:
            await asyncio.sleep(job.interval_seconds)

        while not self._stopping:
            started = time.monotonic()
            try:
                await self._run_once(job)
            except asyncio.CancelledError:
                raise
            elapsed = time.monotonic() - started
            await asyncio.sleep(max(0.0, job.interval_seconds - elapsed))

    async def _run_once(self, job: RuntimeJob) -> None:
        try:
            await self.execute(
                job.name,
                job.fn,
                priority=job.priority,
                timeout_seconds=job.timeout_seconds,
                queue_timeout_seconds=min(job.interval_seconds, job.timeout_seconds),
                lock_key=job.lock_key or f"periodic:{job.name}",
                retry_budget=job.retry_budget,
            )
        except asyncio.CancelledError:
            raise
        except RuntimeError as exc:
            job.skipped += 1
            if "queue is full" in str(exc):
                job.rejected += 1
            job.last_error = str(exc)

    def _eligible_index(self, reserved: bool) -> int | None:
        if not self._queue:
            return None
        if not reserved:
            return 0
        eligible = [
            (work.priority, work.sequence, index)
            for index, work in enumerate(self._queue)
            if work.priority <= self.reserved_priority
        ]
        return min(eligible)[2] if eligible else None

    async def _take_work(self, reserved: bool) -> QueuedWork:
        condition = self._queue_condition
        if condition is None:
            condition = asyncio.Condition()
            self._queue_condition = condition

        async with condition:
            while True:
                index = self._eligible_index(reserved)
                if index is not None:
                    work = self._queue[index]
                    last = self._queue.pop()
                    if index < len(self._queue):
                        self._queue[index] = last
                        heapq.heapify(self._queue)
                    if work.lock_key:
                        self._queued_locks.discard(work.lock_key)
                        self._active_locks.add(work.lock_key)
                    return work
                await condition.wait()

    async def _worker(self, *, reserved: bool) -> None:
        while not self._stopping:
            work = await self._take_work(reserved)
            now = time.monotonic()
            if now > work.deadline_at:
                self._expired += 1
                if work.lock_key:
                    self._active_locks.discard(work.lock_key)
                if not work.future.done():
                    work.future.set_exception(asyncio.TimeoutError("job expired in queue"))
                continue

            queue_ms = (now - work.enqueued_at) * 1000
            self._remember(self._queue_latency_ms, queue_ms)
            self._active_by_priority[work.priority] += 1
            runtime_job = self.jobs.get(work.name)
            if runtime_job:
                runtime_job.running = True
                runtime_job.last_started_at = time.time()
                runtime_job.last_queue_ms = round(queue_ms, 2)

            started = time.perf_counter()
            error: BaseException | None = None
            result: Any = None
            attempts = work.retry_budget + 1
            for attempt in range(attempts):
                try:
                    result = await asyncio.wait_for(work.fn(), timeout=work.timeout_seconds)
                    error = None
                    break
                except asyncio.CancelledError:
                    raise
                except asyncio.TimeoutError as exc:
                    error = exc
                    self._timed_out += 1
                except Exception as exc:
                    error = exc
                if attempt + 1 < attempts:
                    self._retried += 1
                    if runtime_job:
                        runtime_job.retries += 1
                    await asyncio.sleep(min(0.5, 0.05 * (2 ** attempt)))

            duration_ms = (time.perf_counter() - started) * 1000
            self._remember(self._run_latency_ms, duration_ms)
            self._active_by_priority[work.priority] -= 1
            if work.lock_key:
                self._active_locks.discard(work.lock_key)

            if runtime_job:
                runtime_job.runs += 1
                runtime_job.running = False
                runtime_job.last_finished_at = time.time()
                runtime_job.last_duration_ms = round(duration_ms, 2)
                if error is None:
                    runtime_job.consecutive_failures = 0
                    runtime_job.last_error = None
                else:
                    runtime_job.failures += 1
                    runtime_job.consecutive_failures += 1
                    runtime_job.last_error = f"{type(error).__name__}: {error}"

            if error is None:
                self._completed += 1
                if not work.future.done():
                    work.future.set_result(result)
            else:
                self._failed += 1
                if not work.future.done():
                    work.future.set_exception(error)

    def _remember(self, values: deque[float], value: float) -> None:
        if values.maxlen != self.latency_sample_size:
            replacement = deque(values, maxlen=max(32, self.latency_sample_size))
            if values is self._queue_latency_ms:
                self._queue_latency_ms = replacement
            else:
                self._run_latency_ms = replacement
            values = replacement
        values.append(value)

    def status(self) -> dict[str, Any]:
        now = time.time()
        jobs = {}
        stale_jobs = []
        for name, job in self.jobs.items():
            age = now - job.last_finished_at if job.last_finished_at else None
            stale = bool(age is not None and age > self.stale_after_seconds)
            if stale:
                stale_jobs.append(name)
            jobs[name] = {
                "enabled": job.enabled,
                "running": job.running,
                "priority": job.priority,
                "priorityRank": PRIORITIES[job.priority],
                "intervalSeconds": job.interval_seconds,
                "timeoutSeconds": job.timeout_seconds,
                "retryBudget": job.retry_budget,
                "runs": job.runs,
                "failures": job.failures,
                "consecutiveFailures": job.consecutive_failures,
                "skipped": job.skipped,
                "rejected": job.rejected,
                "retries": job.retries,
                "lastStartedAt": job.last_started_at,
                "lastFinishedAt": job.last_finished_at,
                "lastAgeSeconds": round(age, 3) if age is not None else None,
                "lastDurationMs": job.last_duration_ms,
                "lastQueueMs": job.last_queue_ms,
                "lastError": job.last_error,
                "stale": stale,
            }
        queued_by_priority: dict[str, int] = defaultdict(int)
        for work in self._queue:
            queued_by_priority[str(work.priority)] += 1
        return {
            "running": not self._stopping,
            "uptimeSeconds": round(now - self._started_at, 3),
            "maxConcurrentJobs": max(2, self.max_concurrent_jobs),
            "reservedWorkerMaxPriority": self.reserved_priority,
            "maxQueueSize": self.max_queue_size,
            "queueDepth": len(self._queue),
            "queueByPriority": dict(queued_by_priority),
            "activeByPriority": {
                str(priority): count
                for priority, count in self._active_by_priority.items()
                if count > 0
            },
            "submitted": self._submitted,
            "completed": self._completed,
            "failed": self._failed,
            "timedOut": self._timed_out,
            "rejected": self._rejected,
            "preempted": self._preempted,
            "deduplicated": self._deduplicated,
            "expired": self._expired,
            "retried": self._retried,
            "queueLatencyMs": {
                "p50": _percentile(self._queue_latency_ms, 0.50),
                "p95": _percentile(self._queue_latency_ms, 0.95),
                "p99": _percentile(self._queue_latency_ms, 0.99),
            },
            "runLatencyMs": {
                "p50": _percentile(self._run_latency_ms, 0.50),
                "p95": _percentile(self._run_latency_ms, 0.95),
                "p99": _percentile(self._run_latency_ms, 0.99),
            },
            "staleAfterSeconds": self.stale_after_seconds,
            "staleJobs": stale_jobs,
            "jobs": jobs,
        }
