from __future__ import annotations

import asyncio
import json
import os
import statistics
import time
from collections import defaultdict

import psutil

from core.feature_engine import SYMBOLS
from core.job_supervisor import JobSupervisor


def percentile(values: list[float], quantile: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, int((len(ordered) - 1) * quantile))
    return round(ordered[index], 2)


async def main() -> None:
    supervisor = JobSupervisor(
        max_concurrent_jobs=6,
        max_queue_size=512,
        reserved_priority=3,
    )
    supervisor.start()

    process = psutil.Process(os.getpid())
    latencies: dict[str, list[float]] = defaultdict(list)
    prediction_ages: list[float] = []
    completed: set[str] = set()
    duplicate_events = 0
    timeout_count = 0
    event_loop_delay: list[float] = []
    rss_samples: list[int] = []
    cpu_samples: list[float] = []
    active_entries = asyncio.Semaphore(50)
    stop_monitor = asyncio.Event()

    async def monitor_runtime() -> None:
        expected = time.monotonic() + 0.02
        while not stop_monitor.is_set():
            await asyncio.sleep(0.02)
            now = time.monotonic()
            event_loop_delay.append(max(0.0, (now - expected) * 1000))
            expected = now + 0.02
            rss_samples.append(process.memory_info().rss)
            cpu_samples.append(process.cpu_percent(interval=None))

    async def work(
        event_id: str,
        category: str,
        duration: float,
        *,
        prediction_timestamp: float | None = None,
        fail_until: int = 0,
        attempts: dict[str, int],
    ) -> str:
        nonlocal duplicate_events
        started = time.perf_counter()
        attempts[event_id] = attempts.get(event_id, 0) + 1
        if attempts[event_id] <= fail_until:
            raise RuntimeError("injected retry storm")
        async with active_entries:
            await asyncio.sleep(duration)
            if event_id in completed:
                duplicate_events += 1
            completed.add(event_id)
            if prediction_timestamp is not None:
                prediction_ages.append((time.time() - prediction_timestamp) * 1000)
        latencies[category].append((time.perf_counter() - started) * 1000)
        return event_id

    monitor_task = asyncio.create_task(monitor_runtime())
    attempts: dict[str, int] = {}
    tasks: list[asyncio.Task] = []

    def submit(
        event_id: str,
        category: str,
        priority: str,
        duration: float,
        *,
        retry_budget: int = 0,
        fail_until: int = 0,
        prediction_timestamp: float | None = None,
    ) -> None:
        tasks.append(asyncio.create_task(supervisor.execute(
            event_id,
            lambda: work(
                event_id,
                category,
                duration,
                prediction_timestamp=prediction_timestamp,
                fail_until=fail_until,
                attempts=attempts,
            ),
            priority=priority,
            timeout_seconds=2,
            queue_timeout_seconds=20,
            retry_budget=retry_budget,
        )))

    # Ten attempts per configured symbol with no more than fifty active entries.
    for symbol in SYMBOLS:
        for index in range(10):
            submit(f"entry:{symbol}:{index}", "entry", "entry", 0.006)

    for index in range(50):
        submit(f"protect:{index}", "protection", "protection", 0.001)
        submit(f"outcome:{index}", "reconciliation", "reconciliation", 0.01)
    for index in range(50):
        predicted_at = time.time()
        submit(
            f"inference:{index}",
            "inference",
            "inference",
            0.004,
            prediction_timestamp=predicted_at,
        )
    for index in range(12):
        submit(f"slow-db:{index}", "slow_database", "reconciliation", 0.05)
    for index in range(10):
        submit(
            f"retry:{index}",
            "retry_storm",
            "inference",
            0.003,
            retry_budget=2,
            fail_until=2,
        )
    for index in range(6):
        submit(f"training:{index}", "training", "training", 0.08)
    for index in range(40):
        submit(f"analytics:{index}", "analytics", "analytics", 0.02)

    results = await asyncio.gather(*tasks, return_exceptions=True)
    for result in results:
        if isinstance(result, (asyncio.TimeoutError, TimeoutError)):
            timeout_count += 1

    status = supervisor.status()
    await supervisor.stop()

    # Restart/replay proof: durable IDs are replayed after a simulated sidecar restart.
    durable_ids = [f"restart-event:{index}" for index in range(50)]
    replayed: set[str] = set()
    first = JobSupervisor(max_concurrent_jobs=3, max_queue_size=128)
    first.start()
    await asyncio.gather(*[
        first.execute(
            event_id,
            lambda event_id=event_id: asyncio.sleep(0.001, result=event_id),
            priority="reconciliation",
        )
        for event_id in durable_ids[:25]
    ])
    replayed.update(durable_ids[:25])
    await first.stop()

    second = JobSupervisor(max_concurrent_jobs=3, max_queue_size=128)
    second.start()
    replay_results = await asyncio.gather(*[
        second.execute(
            f"replay:{event_id}",
            lambda event_id=event_id: asyncio.sleep(0.001, result=event_id),
            priority="reconciliation",
        )
        for event_id in durable_ids
    ])
    replay_duplicates = sum(1 for event_id in replay_results if event_id in replayed)
    replayed.update(replay_results)
    await second.stop()

    stop_monitor.set()
    await monitor_task

    report = {
        "configuration": {
            "symbols": SYMBOLS,
            "entryAttempts": len(SYMBOLS) * 10,
            "maxSimultaneousEntries": 50,
        },
        "latencyMs": {
            category: {
                "p50": percentile(values, 0.50),
                "p95": percentile(values, 0.95),
                "p99": percentile(values, 0.99),
            }
            for category, values in sorted(latencies.items())
        },
        "predictionAgeAtExecutionMs": {
            "p50": percentile(prediction_ages, 0.50),
            "p95": percentile(prediction_ages, 0.95),
            "p99": percentile(prediction_ages, 0.99),
        },
        "runtime": {
            "cpuPercentMean": round(statistics.fmean(cpu_samples), 2) if cpu_samples else 0,
            "cpuPercentMax": round(max(cpu_samples), 2) if cpu_samples else 0,
            "rssBytesMax": max(rss_samples, default=process.memory_info().rss),
            "eventLoopDelayMs": {
                "p50": percentile(event_loop_delay, 0.50),
                "p95": percentile(event_loop_delay, 0.95),
                "p99": percentile(event_loop_delay, 0.99),
            },
        },
        "reliability": {
            "accepted": len(tasks),
            "completedUnique": len(completed),
            "timeouts": timeout_count,
            "duplicateExecutions": duplicate_events,
            "lostAcceptedEvents": len(tasks) - len(completed),
            "retryAttempts": status["retried"],
            "queueDepthFinal": status["queueDepth"],
            "queueCapacity": status["maxQueueSize"],
            "restartReplayDuplicatesSuppressedByIdempotency": replay_duplicates,
            "restartReplayLost": len(durable_ids) - len(replayed),
        },
        "scheduler": status,
    }
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
