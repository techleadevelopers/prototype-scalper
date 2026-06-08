from __future__ import annotations

import asyncio
import sqlite3
import time
import unittest
import uuid
from pathlib import Path

from core import knowledge_base as kb


class SniperReconciliationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.original_db_path = kb.DB_PATH
        kb.DB_PATH = Path(__file__).parent / f"sniper-reconciliation-{uuid.uuid4().hex}.db"
        asyncio.run(kb.init_db())

    @classmethod
    def tearDownClass(cls) -> None:
        db_path = kb.DB_PATH
        kb.DB_PATH = cls.original_db_path
        for suffix in ("", "-shm", "-wal"):
            candidate = Path(f"{db_path}{suffix}")
            if candidate.exists():
                candidate.unlink()

    def setUp(self) -> None:
        db = sqlite3.connect(kb.DB_PATH)
        try:
            db.execute("DELETE FROM trade_outcomes")
            db.execute("DELETE FROM signal_outcomes")
            db.commit()
        finally:
            db.close()

    async def _decision(
        self,
        signal_id: str,
        *,
        market_event_id: str,
        allowed: bool,
        hit: bool,
    ) -> None:
        now = time.time()
        await kb.record_signal_decision(
            signal_id=signal_id,
            symbol="ETH-USDT",
            side="LONG",
            decision="ALLOW_LONG" if allowed else "BLOCK_LONG",
            decision_group="ALLOW" if allowed else "BLOCK",
            source_type="shadow_sampler",
            strategy_version="sniper-v2",
            config_hash="config-v1",
            context_key="ctx",
            features={"stop_move_pct": 0.55},
            reasons=["unit-test"],
            entry_price=100.0,
            estimated_cost_pct=0.02,
            target_moves={"configured": 0.22, "0.5": 0.5, "1.0": 1.0, "2.0": 2.0},
            market_event_id=market_event_id,
            decision_timestamp=now,
            allowed=allowed,
            reject_reasons=[] if allowed else ["TEST_REJECT"],
            raw_score=0.72,
            calibrated_score=0.70,
            playbook="TREND_SCALP",
        )
        async with kb.connect(kb.DB_PATH) as db:
            await db.execute(
                """UPDATE signal_outcomes
                   SET finalized=1, finalized_at=?, hit_configured=?
                   WHERE signal_id=?""",
                (now + 301, 1 if hit else 0, signal_id),
            )
            await db.commit()

    def test_blocked_win_is_bad_block_and_missed_win(self) -> None:
        async def scenario():
            await self._decision("blocked-win", market_event_id="evt-1", allowed=False, hit=True)
            return await kb.get_sniper_reconciliation_status(days=1)

        status = asyncio.run(scenario())
        self.assertEqual(status["missedWins"], 1)
        self.assertEqual(status["badBlocks"], 1)

    def test_blocked_loss_is_good_block_and_avoided_loss(self) -> None:
        async def scenario():
            await self._decision("blocked-loss", market_event_id="evt-2", allowed=False, hit=False)
            return await kb.get_sniper_reconciliation_status(days=1)

        status = asyncio.run(scenario())
        self.assertEqual(status["avoidedLosses"], 1)
        self.assertEqual(status["goodBlocks"], 1)

    def test_executed_hypothetical_win_realized_loss_is_execution_loss(self) -> None:
        async def scenario():
            await self._decision("exec-loss", market_event_id="evt-3", allowed=True, hit=True)
            await kb.record_trade_outcome(
                source_id="campaign:exec-loss",
                signal_id="exec-loss",
                market_event_id="evt-3",
                source="bingx-vst",
                source_type="demo",
                is_demo=True,
                symbol="ETH-USDT",
                side="LONG",
                pnl_pct=-0.10,
                pnl_usdt=-0.01,
            )
            return await kb.get_sniper_reconciliation_status(days=1)

        status = asyncio.run(scenario())
        self.assertEqual(status["executionLosses"], 1)
        self.assertEqual(status["classifications"]["EXECUTION_LOSS"], 1)

    def test_duplicate_market_event_is_counted_once(self) -> None:
        async def scenario():
            await self._decision("dup-a", market_event_id="evt-dup", allowed=False, hit=True)
            await self._decision("dup-b", market_event_id="evt-dup", allowed=False, hit=True)
            return await kb.get_sniper_reconciliation_status(days=1)

        status = asyncio.run(scenario())
        self.assertEqual(status["totalDecisions"], 1)
        self.assertEqual(status["missedWins"], 1)


if __name__ == "__main__":
    unittest.main()
