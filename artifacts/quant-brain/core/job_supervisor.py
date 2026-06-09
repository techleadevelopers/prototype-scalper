from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any


JobFn = Callable[[], Awaitable[Any]]


@dataclass
class RuntimeJob:
    name: str
    fn: JobFn
    interval_seconds: float
    timeout_seconds: float
    priority: str = "normal"
    enabled: bool = True
    run_immediately: bool = True
    consecutive_failures: int = 0
    runs: int = 0
    failures: int = 0
    skipped: int = 0
    last_started_at: float = 0.0
    last_finished_at: float = 0.0
    last_duration_ms: float = 0.0
    last_error: str | None = None
    running: bool = False


@dataclass
class JobSupervisor:
    max_concurrent_jobs: int = 2
    stale_after_seconds: float = 120.0
    max_queue_size: int = 256
    reserved_priority: int = 1
    jobs: dict[str, RuntimeJob] = field(default_factory=dict)
    _tasks: list[asyncio.Task] = field(default_factory=list)
    _semaphore: asyncio.Semaphore | None = None
    _started_at: float = field(default_factory=time.time)
    _stopping: bool = False
    _queued: int = 0
    _completed: int = 0
    _failed: int = 0
    _rejected: int = 0
    _retried: int = 0
    _deduplicated: int = 0
    _preempted: int = 0
    _locks: set[str] = field(default_factory=set)
    _preempt_low_priority_count: int = 0

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
    ) -> None:
        self.jobs[name] = RuntimeJob(
            name=name,
            fn=fn,
            interval_seconds=max(0.1, float(interval_seconds)),
            timeout_seconds=max(0.1, float(timeout_seconds)),
            priority=priority,
            run_immediately=run_immediately,
            enabled=enabled,
        )

    def start(self) -> None:
        if self._semaphore is None:
            self._semaphore = asyncio.Semaphore(max(1, self.max_concurrent_jobs))
        for job in self.jobs.values():
            if job.enabled and not any(t.get_name() == f"job:{job.name}" for t in self._tasks):
                self._tasks.append(asyncio.create_task(self._runner(job), name=f"job:{job.name}"))

    def _priority_rank(self, priority: str) -> int:
        order = {
            "protection": 100,
            "critical": 90,
            "entry": 70,
            "reconciliation": 60,
            "inference": 50,
            "market": 45,
            "normal": 40,
            "training": 20,
            "analytics": 10,
            "low": 0,
        }
        return order.get(priority, 40)

    def _is_low_priority(self, priority: str) -> bool:
        return self._priority_rank(priority) <= self._priority_rank("analytics")

    async def execute(
        self,
        name: str,
        fn: JobFn,
        *,
        priority: str = "normal",
        timeout_seconds: float = 30.0,
        queue_timeout_seconds: float | None = None,
        retry_budget: int = 0,
        lock_key: str | None = None,
    ) -> Any:
        if self._semaphore is None:
            self._semaphore = asyncio.Semaphore(max(1, self.max_concurrent_jobs))

        if lock_key:
            if lock_key in self._locks:
                self._deduplicated += 1
                raise RuntimeError(f"lock already held: {lock_key}")
            self._locks.add(lock_key)

        bypass_queue = self._priority_rank(priority) >= self._priority_rank("protection")
        if self._queued >= self.max_queue_size and not bypass_queue:
            self._rejected += 1
            if lock_key:
                self._locks.discard(lock_key)
            raise RuntimeError("job queue full")
        if self._queued >= self.max_queue_size and bypass_queue:
            self._preempted += 1
            self._preempt_low_priority_count += 1

        self._queued += 1
        try:
            if bypass_queue:
                return await self._execute_with_retries(name, fn, priority, timeout_seconds, retry_budget)

            acquire = self._semaphore.acquire()
            if queue_timeout_seconds is not None:
                await asyncio.wait_for(acquire, timeout=queue_timeout_seconds)
            else:
                await acquire
            try:
                if self._is_low_priority(priority) and self._preempt_low_priority_count > 0:
                    self._preempt_low_priority_count -= 1
                    self._rejected += 1
                    raise RuntimeError("preempted by critical work")
                return await self._execute_with_retries(name, fn, priority, timeout_seconds, retry_budget)
            finally:
                self._semaphore.release()
        except Exception:
            raise
        finally:
            self._queued = max(0, self._queued - 1)
            if lock_key:
                self._locks.discard(lock_key)

    async def _execute_with_retries(
        self,
        name: str,
        fn: JobFn,
        priority: str,
        timeout_seconds: float,
        retry_budget: int,
    ) -> Any:
        attempts = max(1, retry_budget + 1)
        last_error: Exception | None = None
        for attempt in range(attempts):
            try:
                result = await asyncio.wait_for(fn(), timeout=max(0.1, timeout_seconds))
                self._completed += 1
                return result
            except Exception as exc:
                last_error = exc
                if attempt < attempts - 1:
                    self._retried += 1
                    continue
                self._failed += 1
                raise
        raise last_error or RuntimeError(f"job failed: {name}")

    async def stop(self) -> None:
        self._stopping = True
        for task in self._tasks:
            task.cancel()
        for task in self._tasks:
            try:
                await task
            except asyncio.CancelledError:
                pass
        self._tasks.clear()

    async def _runner(self, job: RuntimeJob) -> None:
        if not job.run_immediately:
            await asyncio.sleep(job.interval_seconds)

        while not self._stopping:
            started = time.time()
            try:
                await self._run_once(job)
            except asyncio.CancelledError:
                raise

            elapsed = time.time() - started
            await asyncio.sleep(max(0.0, job.interval_seconds - elapsed))

    async def _run_once(self, job: RuntimeJob) -> None:
        if self._semaphore is None:
            self._semaphore = asyncio.Semaphore(max(1, self.max_concurrent_jobs))
        if self._semaphore.locked() and job.priority == "low":
            job.skipped += 1
            return

        async with self._semaphore:
            job.running = True
            job.last_started_at = time.time()
            started = time.perf_counter()
            try:
                await asyncio.wait_for(job.fn(), timeout=job.timeout_seconds)
                job.consecutive_failures = 0
                job.last_error = None
            except asyncio.TimeoutError:
                job.failures += 1
                job.consecutive_failures += 1
                job.last_error = f"timeout after {job.timeout_seconds:.1f}s"
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                job.failures += 1
                job.consecutive_failures += 1
                job.last_error = f"{type(exc).__name__}: {exc}"
            finally:
                job.runs += 1
                job.running = False
                job.last_finished_at = time.time()
                job.last_duration_ms = round((time.perf_counter() - started) * 1000, 2)

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
                "intervalSeconds": job.interval_seconds,
                "timeoutSeconds": job.timeout_seconds,
                "runs": job.runs,
                "failures": job.failures,
                "consecutiveFailures": job.consecutive_failures,
                "skipped": job.skipped,
                "lastStartedAt": job.last_started_at,
                "lastFinishedAt": job.last_finished_at,
                "lastAgeSeconds": round(age, 3) if age is not None else None,
                "lastDurationMs": job.last_duration_ms,
                "lastError": job.last_error,
                "stale": stale,
            }
        return {
            "running": not self._stopping,
            "uptimeSeconds": round(now - self._started_at, 3),
            "maxConcurrentJobs": self.max_concurrent_jobs,
            "maxQueueSize": self.max_queue_size,
            "queueDepth": self._queued,
            "completed": self._completed,
            "failed": self._failed,
            "rejected": self._rejected,
            "retried": self._retried,
            "deduplicated": self._deduplicated,
            "preempted": self._preempted,
            "staleAfterSeconds": self.stale_after_seconds,
            "staleJobs": stale_jobs,
            "jobs": jobs,
        }
