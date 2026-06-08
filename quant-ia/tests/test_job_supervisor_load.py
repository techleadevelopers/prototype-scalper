from __future__ import annotations

import asyncio
import time
import unittest

from core.feature_engine import SYMBOLS
from core.job_supervisor import JobSupervisor


class JobSupervisorLoadTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.supervisor = JobSupervisor(
            max_concurrent_jobs=3,
            max_queue_size=512,
            reserved_priority=3,
        )
        self.supervisor.start()

    async def asyncTearDown(self) -> None:
        await self.supervisor.stop()

    async def test_training_and_logging_cannot_starve_protection(self) -> None:
        blockers = [
            asyncio.create_task(
                self.supervisor.execute(
                    f"training-{index}",
                    lambda: asyncio.sleep(0.2),
                    priority="training",
                    timeout_seconds=1,
                )
            )
            for index in range(2)
        ]
        blockers.extend(
            asyncio.create_task(
                self.supervisor.execute(
                    f"analytics-{index}",
                    lambda: asyncio.sleep(0.05),
                    priority="analytics",
                    timeout_seconds=1,
                )
            )
            for index in range(40)
        )

        await asyncio.sleep(0.02)
        started = time.perf_counter()
        await self.supervisor.execute(
            "position-protection",
            lambda: asyncio.sleep(0.002),
            priority="protection",
            timeout_seconds=0.2,
            queue_timeout_seconds=0.1,
        )
        protection_ms = (time.perf_counter() - started) * 1000

        await asyncio.gather(*blockers)
        self.assertLess(
            protection_ms,
            500,
            f"protection waited {protection_ms:.2f}ms behind low-priority work",
        )
        self.assertEqual(self.supervisor.status()["rejected"], 0)

    async def test_aggressive_vst_load_is_bounded_and_lossless(self) -> None:
        attempts: dict[str, int] = {}
        completed: set[str] = set()
        active_entries = asyncio.Semaphore(50)

        async def workload(event_id: str, duration: float, fail_twice: bool = False):
            async with active_entries:
                attempts[event_id] = attempts.get(event_id, 0) + 1
                if fail_twice and attempts[event_id] <= 2:
                    raise RuntimeError("injected retry storm")
                await asyncio.sleep(duration)
                completed.add(event_id)
                return event_id

        tasks: list[asyncio.Task] = []

        # All configured symbols, ten entry attempts per symbol, capped at fifty active.
        for symbol in SYMBOLS:
            for index in range(10):
                event_id = f"entry:{symbol}:{index}"
                tasks.append(asyncio.create_task(
                    self.supervisor.execute(
                        event_id,
                        lambda event_id=event_id: workload(event_id, 0.003),
                        priority="entry",
                        timeout_seconds=1,
                    )
                ))

        # Overlapping monitoring, reconciliation, inference, outcomes, training,
        # database slowdown, analytics, and bounded retry storms.
        for index in range(50):
            event_id = f"monitor:{index}"
            tasks.append(asyncio.create_task(
                self.supervisor.execute(
                    event_id,
                    lambda event_id=event_id: workload(event_id, 0.001),
                    priority="protection",
                    timeout_seconds=1,
                )
            ))
        for index in range(50):
            event_id = f"outcome:{index}"
            tasks.append(asyncio.create_task(
                self.supervisor.execute(
                    event_id,
                    lambda event_id=event_id: workload(event_id, 0.008),
                    priority="reconciliation",
                    timeout_seconds=1,
                )
            ))
        for index in range(40):
            event_id = f"inference:{index}"
            tasks.append(asyncio.create_task(
                self.supervisor.execute(
                    event_id,
                    lambda event_id=event_id: workload(event_id, 0.004),
                    priority="inference",
                    timeout_seconds=1,
                )
            ))
        for index in range(10):
            event_id = f"slow-db:{index}"
            tasks.append(asyncio.create_task(
                self.supervisor.execute(
                    event_id,
                    lambda event_id=event_id: workload(event_id, 0.03),
                    priority="reconciliation",
                    timeout_seconds=1,
                )
            ))
        for index in range(10):
            event_id = f"retry:{index}"
            tasks.append(asyncio.create_task(
                self.supervisor.execute(
                    event_id,
                    lambda event_id=event_id: workload(event_id, 0.002, True),
                    priority="inference",
                    timeout_seconds=1,
                    retry_budget=2,
                )
            ))
        for priority, count in (("training", 4), ("analytics", 20)):
            for index in range(count):
                event_id = f"{priority}:{index}"
                tasks.append(asyncio.create_task(
                    self.supervisor.execute(
                        event_id,
                        lambda event_id=event_id: workload(event_id, 0.015),
                        priority=priority,
                        timeout_seconds=1,
                    )
                ))

        accepted = len(tasks)
        results = await asyncio.gather(*tasks)
        status = self.supervisor.status()

        self.assertEqual(len(results), accepted)
        self.assertEqual(len(completed), accepted)
        self.assertEqual(status["completed"], accepted)
        self.assertEqual(status["failed"], 0)
        self.assertEqual(status["rejected"], 0)
        self.assertEqual(status["retried"], 20)
        self.assertEqual(status["queueDepth"], 0)
        self.assertLessEqual(status["queueDepth"], status["maxQueueSize"])

    async def test_job_lock_rejects_duplicate_training(self) -> None:
        first = asyncio.create_task(
            self.supervisor.execute(
                "training-primary",
                lambda: asyncio.sleep(0.05),
                priority="training",
                timeout_seconds=1,
                lock_key="model-training",
            )
        )
        await asyncio.sleep(0)
        with self.assertRaisesRegex(RuntimeError, "lock already held"):
            await self.supervisor.execute(
                "training-duplicate",
                lambda: asyncio.sleep(0.01),
                priority="training",
                timeout_seconds=1,
                lock_key="model-training",
            )
        await first
        self.assertEqual(self.supervisor.status()["deduplicated"], 1)

    async def test_critical_work_preempts_full_low_priority_queue(self) -> None:
        await self.supervisor.stop()
        self.supervisor = JobSupervisor(
            max_concurrent_jobs=2,
            max_queue_size=2,
            reserved_priority=3,
        )
        self.supervisor.start()

        blocker = asyncio.create_task(self.supervisor.execute(
            "training-blocker",
            lambda: asyncio.sleep(0.2),
            priority="training",
        ))
        await asyncio.sleep(0.02)
        queued = [
            asyncio.create_task(self.supervisor.execute(
                f"analytics-{index}",
                lambda: asyncio.sleep(0.05),
                priority="analytics",
            ))
            for index in range(2)
        ]
        await asyncio.sleep(0.02)

        await self.supervisor.execute(
            "urgent-protection",
            lambda: asyncio.sleep(0.001),
            priority="protection",
            queue_timeout_seconds=0.1,
        )
        await blocker
        results = await asyncio.gather(*queued, return_exceptions=True)

        self.assertTrue(any(isinstance(result, RuntimeError) for result in results))
        self.assertEqual(self.supervisor.status()["preempted"], 1)


if __name__ == "__main__":
    unittest.main()
