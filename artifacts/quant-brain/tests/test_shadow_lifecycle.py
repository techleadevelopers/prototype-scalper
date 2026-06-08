from __future__ import annotations

import asyncio
import sqlite3
import time
import unittest
import uuid
from pathlib import Path

from core import knowledge_base as kb


class ShadowLifecycleTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.original_db_path = kb.DB_PATH
        kb.DB_PATH = Path(__file__).parent / f"shadow-lifecycle-{uuid.uuid4().hex}.db"
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
            db.execute("DELETE FROM hourly_metrics")
            db.execute("DELETE FROM daily_symbol_metrics")
            db.commit()
        finally:
            db.close()

    async def _observe(self, signal_id: str, created_at: float | None = None) -> None:
        await kb.record_signal_decision(
            signal_id=signal_id,
            symbol="ETH-USDT",
            side="LONG",
            decision="ALLOW_LONG",
            decision_group="ALLOW",
            source_type="vst_campaign",
            strategy_version="sniper-v2",
            config_hash="config-v1",
            context_key="ctx",
            features={"alt": {"rsi": 55}, "stop_move_pct": 0.55},
            reasons=[],
            entry_price=100.0,
            estimated_cost_pct=0.14,
            target_moves={"configured": 0.22, "0.5": 0.5, "1.0": 1.0, "2.0": 2.0},
            feature_version="features-v1",
        )
        if created_at is not None:
            async with kb.connect(kb.DB_PATH) as db:
                await db.execute(
                    "UPDATE signal_outcomes SET created_at=? WHERE signal_id=?",
                    (created_at, signal_id),
                )
                await db.commit()

    def test_delayed_campaign_label_reconciles_pending_observation(self) -> None:
        async def scenario():
            await self._observe("campaign-signal-1")
            before = await kb.get_signal_pipeline_summary()
            recorded = await kb.record_trade_outcome(
                source_id="campaign:1",
                signal_id="campaign-signal-1",
                source="bingx-vst",
                is_demo=True,
                symbol="ETH-USDT",
                side="LONG",
                pnl_pct=10.0,
                pnl_usdt=0.5,
            )
            rows = await kb.get_signal_training_rows(source_type="vst_campaign")
            return before, recorded, rows

        before, recorded, rows = asyncio.run(scenario())
        self.assertEqual(before["pending"], 1)
        self.assertTrue(recorded)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["hit_configured"], 1)
        self.assertEqual(rows[0]["label_source"], "realized_campaign")
        self.assertEqual(rows[0]["outcome_source_id"], "campaign:1")

    def test_duplicate_outcome_is_one_trade_and_one_label(self) -> None:
        async def scenario():
            await self._observe("campaign-signal-2")
            for _ in range(2):
                await kb.record_trade_outcome(
                    source_id="campaign:2",
                    signal_id="campaign-signal-2",
                    source="bingx-vst",
                    is_demo=True,
                    symbol="ETH-USDT",
                    side="LONG",
                    pnl_pct=-5.0,
                    pnl_usdt=-0.25,
                )

        asyncio.run(scenario())
        db = sqlite3.connect(kb.DB_PATH)
        try:
            trades = db.execute(
                "SELECT COUNT(*) FROM trade_outcomes WHERE source_id='campaign:2'"
            ).fetchone()[0]
            labels = db.execute(
                "SELECT COUNT(*) FROM signal_outcomes WHERE outcome_source_id='campaign:2'"
            ).fetchone()[0]
        finally:
            db.close()
        self.assertEqual(trades, 1)
        self.assertEqual(labels, 1)

    def test_unresolved_campaign_is_reported_as_stale_pending(self) -> None:
        async def scenario():
            await self._observe("never-closed", time.time() - 3600)
            return await kb.get_signal_readiness_diagnostics(
                min_samples=300,
                source_type="vst_campaign",
            )

        diagnostics = asyncio.run(scenario())
        self.assertEqual(diagnostics["state"], "COLLECTING")
        self.assertEqual(diagnostics["stalePending"], 1)

    def test_class_imbalance_blocks_readiness(self) -> None:
        async def scenario():
            now = time.time()
            async with kb.connect(kb.DB_PATH) as db:
                for index in range(20):
                    await db.execute(
                        """INSERT INTO signal_outcomes
                           (signal_id, symbol, side, decision, decision_group, source_type,
                            strategy_version, config_hash, context_key, features, reasons,
                            entry_price, estimated_cost_pct, target_configured_move_pct,
                            target_050_move_pct, target_100_move_pct, target_200_move_pct,
                            hit_configured, finalized, created_at, finalized_at,
                            feature_version, label_version, label_source)
                           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                        (
                            f"imbalanced-{index}", "ETH-USDT", "LONG", "ALLOW_LONG", "ALLOW",
                            "vst_campaign", "sniper-v2", "cfg", "ctx", "{}", "[]", 100.0,
                            0.1, 0.2, 0.5, 1.0, 2.0, 0 if index == 0 else 1, 1,
                            now + index, now + index + 1, "features-v1",
                            "campaign-pnl-v1", "realized_campaign",
                        ),
                    )
                await db.commit()
            return await kb.get_signal_readiness_diagnostics(
                min_samples=20,
                source_type="vst_campaign",
            )

        diagnostics = asyncio.run(scenario())
        self.assertEqual(diagnostics["state"], "CLASS_IMBALANCED")
        self.assertEqual(diagnostics["minorityClassRatio"], 0.05)

    def test_future_label_is_excluded_and_fingerprint_is_stable(self) -> None:
        async def scenario():
            await self._observe("valid")
            await kb.reconcile_signal_outcome("valid", "campaign:valid", True)
            await self._observe("leaky")
            async with kb.connect(kb.DB_PATH) as db:
                await db.execute(
                    """UPDATE signal_outcomes
                       SET finalized=1, hit_configured=0, finalized_at=created_at-1
                       WHERE signal_id='leaky'"""
                )
                await db.commit()
            rows_a = await kb.get_signal_training_rows(source_type="vst_campaign")
            rows_b = await kb.get_signal_training_rows(source_type="vst_campaign")
            diagnostics = await kb.get_signal_readiness_diagnostics(
                min_samples=300,
                source_type="vst_campaign",
            )
            return rows_a, rows_b, diagnostics

        rows_a, rows_b, diagnostics = asyncio.run(scenario())
        self.assertEqual([row["signal_id"] for row in rows_a], ["valid"])
        self.assertEqual(
            kb.signal_dataset_fingerprint(rows_a),
            kb.signal_dataset_fingerprint(rows_b),
        )
        self.assertEqual(diagnostics["invalidOrLeakyLabels"], 1)

    def test_restart_recovery_keeps_idempotent_keys(self) -> None:
        async def first_process():
            await self._observe("restart-signal")
            await kb.record_trade_outcome(
                source_id="campaign:restart",
                signal_id="restart-signal",
                source="bingx-vst",
                is_demo=True,
                symbol="ETH-USDT",
                side="LONG",
                pnl_pct=4.0,
                pnl_usdt=0.2,
            )

        async def second_process():
            await kb.init_db()
            await kb.record_trade_outcome(
                source_id="campaign:restart",
                signal_id="restart-signal",
                source="bingx-vst",
                is_demo=True,
                symbol="ETH-USDT",
                side="LONG",
                pnl_pct=4.0,
                pnl_usdt=0.2,
            )

        asyncio.run(first_process())
        asyncio.run(second_process())
        db = sqlite3.connect(kb.DB_PATH)
        try:
            self.assertEqual(
                db.execute(
                    "SELECT COUNT(*) FROM trade_outcomes WHERE source_id='campaign:restart'"
                ).fetchone()[0],
                1,
            )
            self.assertEqual(
                db.execute(
                    "SELECT COUNT(*) FROM signal_outcomes WHERE outcome_source_id='campaign:restart'"
                ).fetchone()[0],
                1,
            )
        finally:
            db.close()


if __name__ == "__main__":
    unittest.main()
