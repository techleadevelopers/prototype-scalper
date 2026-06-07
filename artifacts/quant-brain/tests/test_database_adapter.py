from __future__ import annotations

import unittest

from core.database import _postgres_ddl, _postgres_sql


class DatabaseAdapterTest(unittest.TestCase):
    def test_postgres_placeholders_are_numbered(self) -> None:
        self.assertEqual(
            _postgres_sql("SELECT * FROM trades WHERE symbol=? AND side=?"),
            "SELECT * FROM trades WHERE symbol=$1 AND side=$2",
        )

    def test_sqlite_autoincrement_is_converted_for_postgres(self) -> None:
        self.assertEqual(
            _postgres_ddl("id INTEGER PRIMARY KEY AUTOINCREMENT"),
            "id BIGSERIAL PRIMARY KEY",
        )


if __name__ == "__main__":
    unittest.main()
