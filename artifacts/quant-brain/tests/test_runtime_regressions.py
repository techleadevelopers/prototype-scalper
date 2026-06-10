from __future__ import annotations

import asyncio
import os
import shutil
import sqlite3
import uuid
import unittest
from pathlib import Path
from unittest.mock import patch

from core import knowledge_base as kb
from layers.strategic import build_strategic_report, compute_entry_quality_by_symbol


class RuntimeRegressionTest(unittest.TestCase):
    def setUp(self) -> None:
        tmp_root = Path(os.environ.get("QUANT_BRAIN_TEST_TMP", str(Path(__file__).parent / ".tmp")))
        tmp_root.mkdir(parents=True, exist_ok=True)
        self.temp_dir = tmp_root / f"runtime-regression-{uuid.uuid4().hex}"
        self.temp_dir.mkdir(parents=True, exist_ok=True)
        self.original_db_path = kb.DB_PATH
        kb.DB_PATH = self.temp_dir / "knowledge.db"

    def tearDown(self) -> None:
        kb.DB_PATH = self.original_db_path
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_init_db_migrates_legacy_signal_table_before_indexes(self) -> None:
        db = sqlite3.connect(kb.DB_PATH)
        try:
            db.execute(
                """CREATE TABLE signal_outcomes (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    signal_id TEXT NOT NULL UNIQUE,
                    symbol TEXT NOT NULL,
                    side TEXT NOT NULL,
                    decision TEXT NOT NULL,
                    context_key TEXT NOT NULL,
                    features TEXT NOT NULL,
                    reasons TEXT NOT NULL,
                    entry_price REAL NOT NULL,
                    target_050_move_pct REAL NOT NULL,
                    target_100_move_pct REAL NOT NULL,
                    target_200_move_pct REAL NOT NULL,
                    finalized INTEGER DEFAULT 0,
                    created_at REAL NOT NULL
                )"""
            )
            db.commit()
        finally:
            db.close()

        asyncio.run(kb.init_db())

        db = sqlite3.connect(kb.DB_PATH)
        try:
            columns = {
                row[1]
                for row in db.execute("PRAGMA table_info(signal_outcomes)").fetchall()
            }
            indexes = {
                row[1]
                for row in db.execute("PRAGMA index_list(signal_outcomes)").fetchall()
            }
        finally:
            db.close()

        self.assertIn("decision_group", columns)
        self.assertIn("hit_configured", columns)
        self.assertIn("idx_signal_decision_group", indexes)
        self.assertIn("idx_signal_hit_rate", indexes)

    def test_strategic_report_supports_empty_database(self) -> None:
        async def scenario():
            await kb.init_db()
            return await build_strategic_report(30)

        report = asyncio.run(scenario())
        self.assertEqual(report.total_trades, 0)
        self.assertEqual(
            report.statistical_tests["win_rate_confidence"]["verdict"],
            "INSUFFICIENT_EVIDENCE",
        )

    def test_entry_quality_uses_signal_hit_rate_without_pnl_pct_column(self) -> None:
        async def scenario():
            await kb.init_db()
            now = 1_800_000_000.0
            async with kb.connect(kb.DB_PATH) as db:
                for index in range(6):
                    await db.execute(
                        """INSERT INTO signal_outcomes
                           (signal_id, symbol, side, decision, decision_group, context_key,
                            features, reasons, entry_price, estimated_cost_pct,
                            target_050_move_pct, target_100_move_pct, target_200_move_pct,
                            hit_configured, finalized, created_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                        (
                            f"sig-{index}",
                            "BTC-USDT",
                            "LONG",
                            "ALLOW",
                            "ALLOW",
                            "ctx",
                            '{"rsi":42,"volume_ratio":1.8,"oi_change_pct":0.2,"funding_rate":0.01}',
                            "[]",
                            100.0,
                            0.0,
                            0.5,
                            1.0,
                            2.0,
                            1 if index < 4 else 0,
                            1,
                            now,
                        ),
                    )
                await db.commit()
            with patch("layers.strategic.time.time", return_value=now + 60):
                return await compute_entry_quality_by_symbol(30)

        quality = asyncio.run(scenario())
        self.assertIn("BTC-USDT_LONG", quality)
        self.assertEqual(quality["BTC-USDT_LONG"]["total"], 6)
        self.assertEqual(quality["BTC-USDT_LONG"]["win_rate"], 66.7)

    def test_liveness_does_not_wait_for_database_initialization(self) -> None:
        from api import server

        async def blocked_init():
            await asyncio.sleep(60)

        async def close_engine():
            return None

        async def scenario():
            server._tasks.clear()
            with patch.object(server.kb, "init_db", side_effect=blocked_init):
                with patch.object(server.engine, "close", new=close_engine):
                    async with server.lifespan(server.app):
                        return await server.liveness_check()

        result = asyncio.run(scenario())
        self.assertEqual(result["status"], "alive")
        self.assertFalse(result["runtime_ready"])


if __name__ == "__main__":
    unittest.main()
