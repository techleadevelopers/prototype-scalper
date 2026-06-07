from __future__ import annotations

import asyncio
import tempfile
import time
import unittest
from pathlib import Path

import aiosqlite

from core import knowledge_base as kb
from core import signal_learning as sl


class SignalOutcomeOrderingTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.original_db_path = kb.DB_PATH
        self.original_history_reader = sl.get_snapshot_history
        kb.DB_PATH = Path(self.temp_dir.name) / "knowledge.db"
        asyncio.run(kb.init_db())

    def tearDown(self) -> None:
        kb.DB_PATH = self.original_db_path
        sl.get_snapshot_history = self.original_history_reader
        self.temp_dir.cleanup()

    async def _seed(self, signal_id: str, symbol: str, created_at: float) -> None:
        await kb.record_signal_decision(
            signal_id=signal_id,
            symbol=symbol,
            side="LONG",
            decision="ALLOW_LONG",
            decision_group="ALLOW",
            source_type="hypothetical",
            strategy_version="sniper-v2",
            config_hash="test",
            context_key="test-context",
            features={"stop_move_pct": 0.55},
            reasons=[],
            entry_price=100.0,
            estimated_cost_pct=0.14,
            target_moves={
                "configured": 0.22,
                "0.5": 0.854,
                "1.0": 1.568,
                "2.0": 2.997,
            },
        )
        async with aiosqlite.connect(kb.DB_PATH) as db:
            await db.execute(
                "UPDATE signal_outcomes SET created_at=? WHERE signal_id=?",
                (created_at, signal_id),
            )
            await db.commit()

    async def _run_ordering_scenario(self) -> tuple[dict, list[tuple]]:
        created_at = time.time() - 310
        await self._seed("target-first", "ETH-USDT", created_at)
        await self._seed("stop-first", "SOL-USDT", created_at)
        histories = {
            "ETH-USDT": [
                {"timestamp": created_at + 10, "bid": 100.25, "ask": 100.27, "price": 100.26},
                {"timestamp": created_at + 20, "bid": 99.40, "ask": 99.42, "price": 99.41},
            ],
            "SOL-USDT": [
                {"timestamp": created_at + 10, "bid": 99.40, "ask": 99.42, "price": 99.41},
                {"timestamp": created_at + 20, "bid": 100.25, "ask": 100.27, "price": 100.26},
            ],
        }
        sl.get_snapshot_history = lambda symbol, _: histories[symbol]

        result = await sl.finalize_due_signal_outcomes()

        async with aiosqlite.connect(kb.DB_PATH) as db:
            rows = await (await db.execute(
                """SELECT signal_id, hit_configured, stopped, first_event
                   FROM signal_outcomes
                   ORDER BY signal_id"""
            )).fetchall()
        return result, rows

    def test_target_and_stop_are_labeled_by_first_event(self) -> None:
        result, rows = asyncio.run(self._run_ordering_scenario())
        self.assertEqual(result["finalized"], 2)
        self.assertEqual(rows, [
            ("stop-first", 0, 1, "STOP"),
            ("target-first", 1, 0, "TARGET_CONFIGURED"),
        ])


if __name__ == "__main__":
    unittest.main()
