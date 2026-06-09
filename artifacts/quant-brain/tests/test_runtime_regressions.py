from __future__ import annotations

import asyncio
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from core import knowledge_base as kb
from layers.strategic import build_strategic_report


class RuntimeRegressionTest(unittest.TestCase):
    def setUp(self) -> None:
        tmp_root = Path(os.environ.get("QUANT_BRAIN_TEST_TMP", r"C:\tmp" if os.name == "nt" else str(Path(__file__).parent / ".tmp")))
        tmp_root.mkdir(parents=True, exist_ok=True)
        self.temp_dir = tempfile.TemporaryDirectory(dir=tmp_root, ignore_cleanup_errors=True)
        self.original_db_path = kb.DB_PATH
        kb.DB_PATH = Path(self.temp_dir.name) / "knowledge.db"

    def tearDown(self) -> None:
        kb.DB_PATH = self.original_db_path
        self.temp_dir.cleanup()

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
