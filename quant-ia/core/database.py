from __future__ import annotations

import os
import re
import time
from collections import deque
from pathlib import Path
from typing import Any, Iterable, Optional

import aiosqlite

try:
    import asyncpg
except ImportError:  # pragma: no cover - SQLite remains available locally.
    asyncpg = None


Row = aiosqlite.Row
IntegrityError = (
    (aiosqlite.IntegrityError, asyncpg.IntegrityConstraintViolationError)
    if asyncpg is not None
    else aiosqlite.IntegrityError
)

_SCHEMA_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_postgres_pool = None
_postgres_pool_url: Optional[str] = None
_db_stats = {
    "acquires": 0,
    "acquire_failures": 0,
    "active": 0,
    "peak_active": 0,
}
_db_acquire_ms: deque[float] = deque(maxlen=2048)


def _percentile(values: deque[float], percentile: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, int((len(ordered) - 1) * percentile)))
    return round(ordered[index], 2)


def database_url() -> Optional[str]:
    value = os.environ.get("QUANT_BRAIN_DATABASE_URL") or os.environ.get("DATABASE_URL")
    return value.strip() if value and value.strip() else None


def database_schema() -> str:
    schema = os.environ.get("QUANT_BRAIN_DB_SCHEMA", "quant_brain").strip()
    if not _SCHEMA_RE.fullmatch(schema):
        raise RuntimeError(f"Invalid QUANT_BRAIN_DB_SCHEMA: {schema!r}")
    return schema


def using_postgres() -> bool:
    return database_url() is not None


def _postgres_sql(query: str) -> str:
    position = 0

    def replace_placeholder(_: re.Match[str]) -> str:
        nonlocal position
        position += 1
        return f"${position}"

    return re.sub(r"\?", replace_placeholder, query)


def _postgres_ddl(script: str) -> str:
    return script.replace(
        "INTEGER PRIMARY KEY AUTOINCREMENT",
        "BIGSERIAL PRIMARY KEY",
    ).replace(" BLOB ", " BYTEA ")


async def _get_postgres_pool():
    global _postgres_pool, _postgres_pool_url

    url = database_url()
    if not url:
        raise RuntimeError("PostgreSQL requested without DATABASE_URL")
    if asyncpg is None:
        raise RuntimeError("asyncpg is required when DATABASE_URL is configured")
    if _postgres_pool is not None and _postgres_pool_url == url:
        return _postgres_pool

    if _postgres_pool is not None:
        await _postgres_pool.close()

    schema = database_schema()
    bootstrap = await asyncpg.connect(url)
    try:
        await bootstrap.execute(f'CREATE SCHEMA IF NOT EXISTS "{schema}"')
    finally:
        await bootstrap.close()

    _postgres_pool = await asyncpg.create_pool(
        url,
        min_size=1,
        max_size=max(2, int(os.environ.get("QUANT_BRAIN_DB_POOL_SIZE", "5"))),
        command_timeout=float(os.environ.get("QUANT_BRAIN_DB_COMMAND_TIMEOUT", "30")),
        server_settings={"search_path": f'"{schema}",public'},
    )
    _postgres_pool_url = url
    return _postgres_pool


class PostgresCursor:
    def __init__(self, rows: Optional[list[Any]] = None, rowcount: int = 0):
        self._rows = rows or []
        self.rowcount = rowcount

    async def fetchone(self):
        return self._rows[0] if self._rows else None

    async def fetchall(self):
        return self._rows


class PostgresConnection:
    row_factory = None

    def __init__(self):
        self._pool = None
        self._connection = None

    async def __aenter__(self):
        self._pool = await _get_postgres_pool()
        started = time.perf_counter()
        try:
            self._connection = await self._pool.acquire()
        except Exception:
            _db_stats["acquire_failures"] += 1
            raise
        _db_acquire_ms.append((time.perf_counter() - started) * 1000)
        _db_stats["acquires"] += 1
        _db_stats["active"] += 1
        _db_stats["peak_active"] = max(_db_stats["peak_active"], _db_stats["active"])
        return self

    async def __aexit__(self, exc_type, exc, traceback):
        if self._connection is not None and self._pool is not None:
            await self._pool.release(self._connection)
            _db_stats["active"] = max(0, _db_stats["active"] - 1)
        self._connection = None

    async def execute(self, query: str, params: Iterable[Any] = ()):
        if self._connection is None:
            raise RuntimeError("Database connection is not open")
        sql = _postgres_sql(query)
        values = tuple(params)
        if sql.lstrip().upper().startswith(("SELECT", "WITH")):
            rows = await self._connection.fetch(sql, *values)
            return PostgresCursor(list(rows))
        status = await self._connection.execute(sql, *values)
        match = re.search(r"(\d+)$", status)
        return PostgresCursor(rowcount=int(match.group(1)) if match else 0)

    async def executescript(self, script: str):
        if self._connection is None:
            raise RuntimeError("Database connection is not open")
        await self._connection.execute(_postgres_ddl(script))

    async def commit(self):
        return None


def connect(path: Path | str):
    if using_postgres():
        return PostgresConnection()
    return aiosqlite.connect(path)


async def table_columns(table: str, path: Path | str) -> set[str]:
    if not _SCHEMA_RE.fullmatch(table):
        raise RuntimeError(f"Invalid table name: {table!r}")
    if using_postgres():
        async with connect(path) as db:
            rows = await (await db.execute(
                """SELECT column_name
                   FROM information_schema.columns
                   WHERE table_schema=? AND table_name=?""",
                (database_schema(), table),
            )).fetchall()
        return {str(row[0]) for row in rows}

    async with connect(path) as db:
        rows = await (await db.execute(f"PRAGMA table_info({table})")).fetchall()
    return {str(row[1]) for row in rows}


async def close_pool():
    global _postgres_pool, _postgres_pool_url
    if _postgres_pool is not None:
        await _postgres_pool.close()
    _postgres_pool = None
    _postgres_pool_url = None


def database_pool_status() -> dict[str, Any]:
    status = {
        "backend": "postgresql" if using_postgres() else "sqlite",
        "configured": bool(_postgres_pool is not None) if using_postgres() else True,
        "acquires": _db_stats["acquires"],
        "acquireFailures": _db_stats["acquire_failures"],
        "active": _db_stats["active"],
        "peakActive": _db_stats["peak_active"],
        "acquireLatencyMs": {
            "p50": _percentile(_db_acquire_ms, 0.50),
            "p95": _percentile(_db_acquire_ms, 0.95),
            "p99": _percentile(_db_acquire_ms, 0.99),
        },
    }
    if _postgres_pool is not None:
        status.update({
            "size": _postgres_pool.get_size(),
            "idle": _postgres_pool.get_idle_size(),
            "minSize": _postgres_pool.get_min_size(),
            "maxSize": _postgres_pool.get_max_size(),
        })
    return status
