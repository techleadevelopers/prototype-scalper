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
    jobs: dict[str, RuntimeJob] = field(default_factory=dict)
    _tasks: list[asyncio.Task] = field(default_factory=list)
    _semaphore: asyncio.Semaphore | None = None
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
            "staleAfterSeconds": self.stale_after_seconds,
            "staleJobs": stale_jobs,
            "jobs": jobs,
        }
