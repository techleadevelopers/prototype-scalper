"""
Knowledge Base — SQLite persistente para padrões, observações e memória do sistema.
Acumula aprendizado 24h/dia sobre os 10 ativos.
Nível Máximo de Excelência: índices otimizados, tabelas de performance,
métricas agregadas, janelas temporais, view materializadas, cache de queries.
"""
from __future__ import annotations

import json
import os
import time
import asyncio
from collections import OrderedDict
from dataclasses import dataclass, asdict
from typing import Optional, Any
from pathlib import Path
from core.database import IntegrityError, Row, connect, table_columns

DB_PATH = Path(__file__).parent.parent / "data" / "knowledge.db"
DB_PATH.parent.mkdir(exist_ok=True)

# Cache LRU para consultas frequentes
_query_cache: OrderedDict = OrderedDict()
_CACHE_MAX_SIZE = 100
_CACHE_TTL_SECONDS = 30


@dataclass
class Pattern:
    id: Optional[int]
    name: str
    symbol: str
    conditions: dict
    occurrences: int
    wins: int
    total_return: float
    avg_return: float
    win_rate: float
    last_seen: float
    created_at: float


@dataclass
class Observation:
    id: Optional[int]
    symbol: str
    category: str
    text: str
    data: dict
    confidence: float
    timestamp: float


@dataclass
class StrategicInsight:
    id: Optional[int]
    period_days: int
    generated_at: float
    analysis_text: str
    edge_changes: dict
    recommendations: list


CREATE_TABLES = """
-- ========== TABELAS EXISTENTES (OTIMIZADAS) ==========

CREATE TABLE IF NOT EXISTS patterns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    symbol TEXT NOT NULL,
    conditions TEXT NOT NULL,
    occurrences INTEGER DEFAULT 0,
    wins INTEGER DEFAULT 0,
    total_return REAL DEFAULT 0.0,
    avg_return REAL DEFAULT 0.0,
    win_rate REAL DEFAULT 0.0,
    last_seen REAL DEFAULT 0.0,
    created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS trade_outcomes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id TEXT UNIQUE,
    source TEXT DEFAULT 'manual',
    is_demo INTEGER DEFAULT 0,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL,
    entry_price REAL,
    exit_price REAL,
    pnl_pct REAL,
    pnl_usdt REAL,
    win INTEGER DEFAULT 0,
    oi_at_entry REAL,
    funding_at_entry REAL,
    volume_ratio REAL,
    btc_regime TEXT,
    rsi_at_entry REAL,
    ema_cross TEXT,
    slippage_bps REAL DEFAULT 0,
    fee_paid_usdt REAL DEFAULT 0,
    risk_tier TEXT,
    size_multiplier REAL,
    size_reason TEXT,
    timestamp REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    category TEXT NOT NULL,
    text TEXT NOT NULL,
    data TEXT NOT NULL,
    confidence REAL DEFAULT 0.0,
    timestamp REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS strategic_insights (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    period_days INTEGER NOT NULL,
    generated_at REAL NOT NULL,
    analysis_text TEXT NOT NULL,
    edge_changes TEXT NOT NULL,
    recommendations TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS feature_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    timestamp REAL NOT NULL,
    price REAL,
    price_change_pct REAL,
    volume_ratio REAL,
    oi_change_pct REAL,
    funding_rate REAL,
    rsi REAL,
    ema_cross TEXT,
    atr_pct REAL,
    spread_bps REAL,
    btc_regime TEXT,
    bid_depth_5 REAL,
    ask_depth_5 REAL,
    book_imbalance REAL,
    cvd REAL
);

CREATE TABLE IF NOT EXISTS signal_outcomes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    signal_id TEXT NOT NULL UNIQUE,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL,
    decision TEXT NOT NULL,
    decision_group TEXT NOT NULL DEFAULT 'WAIT',
    source_type TEXT NOT NULL DEFAULT 'hypothetical',
    strategy_version TEXT NOT NULL DEFAULT 'legacy',
    config_hash TEXT NOT NULL DEFAULT '',
    context_key TEXT NOT NULL,
    features TEXT NOT NULL,
    reasons TEXT NOT NULL,
    entry_price REAL NOT NULL,
    estimated_cost_pct REAL NOT NULL DEFAULT 0,
    target_configured_move_pct REAL,
    target_050_move_pct REAL NOT NULL,
    target_100_move_pct REAL NOT NULL,
    target_200_move_pct REAL NOT NULL,
    price_30s REAL,
    price_60s REAL,
    price_120s REAL,
    price_300s REAL,
    hit_configured INTEGER,
    hit_050 INTEGER,
    hit_100 INTEGER,
    hit_200 INTEGER,
    stopped INTEGER,
    first_event TEXT,
    first_event_seconds REAL,
    max_favorable_pct REAL,
    max_adverse_pct REAL,
    finalized INTEGER DEFAULT 0,
    created_at REAL NOT NULL,
    finalized_at REAL
);

CREATE TABLE IF NOT EXISTS news_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    title TEXT NOT NULL,
    url TEXT,
    symbols TEXT NOT NULL,
    category TEXT NOT NULL,
    impact_score REAL NOT NULL,
    risk_level TEXT NOT NULL,
    action TEXT NOT NULL,
    raw TEXT NOT NULL,
    created_at REAL NOT NULL,
    expires_at REAL NOT NULL
);

-- ========== NOVAS TABELAS PARA NÍVEL MÁXIMO DE EXCELÊNCIA ==========

-- Tabela de métricas horárias agregadas para queries rápidas
CREATE TABLE IF NOT EXISTS hourly_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    hour_utc INTEGER NOT NULL,
    date TEXT NOT NULL,
    trades INTEGER DEFAULT 0,
    wins INTEGER DEFAULT 0,
    total_pnl_pct REAL DEFAULT 0,
    total_pnl_usdt REAL DEFAULT 0,
    avg_pnl_pct REAL DEFAULT 0,
    win_rate REAL DEFAULT 0,
    UNIQUE(symbol, date, hour_utc)
);

-- Tabela de métricas diárias por símbolo/lado
CREATE TABLE IF NOT EXISTS daily_symbol_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL,
    date TEXT NOT NULL,
    trades INTEGER DEFAULT 0,
    wins INTEGER DEFAULT 0,
    total_pnl_pct REAL DEFAULT 0,
    total_pnl_usdt REAL DEFAULT 0,
    avg_pnl_pct REAL DEFAULT 0,
    win_rate REAL DEFAULT 0,
    max_drawdown_pct REAL DEFAULT 0,
    sharpe_ratio REAL DEFAULT 0,
    UNIQUE(symbol, side, date)
);

-- Tabela de análise de correlação entre símbolos
CREATE TABLE IF NOT EXISTS symbol_correlations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol_a TEXT NOT NULL,
    symbol_b TEXT NOT NULL,
    correlation_1h REAL DEFAULT 0,
    correlation_4h REAL DEFAULT 0,
    correlation_24h REAL DEFAULT 0,
    computed_at REAL NOT NULL,
    UNIQUE(symbol_a, symbol_b)
);

-- Tabela de performance por regime de BTC
CREATE TABLE IF NOT EXISTS regime_performance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    btc_regime TEXT NOT NULL,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL,
    trades INTEGER DEFAULT 0,
    wins INTEGER DEFAULT 0,
    total_pnl_pct REAL DEFAULT 0,
    win_rate REAL DEFAULT 0,
    period_start REAL NOT NULL,
    period_end REAL NOT NULL,
    UNIQUE(btc_regime, symbol, side, period_start)
);

-- Tabela de toxicidade por horário
CREATE TABLE IF NOT EXISTS hour_toxicity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    hour_utc INTEGER NOT NULL,
    side TEXT NOT NULL,
    trades INTEGER DEFAULT 0,
    win_rate REAL DEFAULT 0,
    avg_pnl_pct REAL DEFAULT 0,
    toxicity_score REAL DEFAULT 0,
    updated_at REAL NOT NULL,
    UNIQUE(symbol, hour_utc, side)
);

-- Tabela de rolling edge (janela móvel)
CREATE TABLE IF NOT EXISTS rolling_edge (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL,
    window_hours INTEGER NOT NULL,
    win_rate REAL DEFAULT 0,
    avg_pnl_pct REAL DEFAULT 0,
    profit_factor REAL DEFAULT 0,
    computed_at REAL NOT NULL,
    UNIQUE(symbol, side, window_hours, computed_at)
);

-- Tabela de execução quality (slippage real)
CREATE TABLE IF NOT EXISTS execution_quality (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL,
    expected_price REAL NOT NULL,
    executed_price REAL NOT NULL,
    slippage_bps REAL NOT NULL,
    latency_ms REAL NOT NULL,
    timestamp REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS model_artifacts (
    name TEXT PRIMARY KEY,
    content BLOB NOT NULL,
    metadata TEXT NOT NULL,
    updated_at REAL NOT NULL
);

-- ========== ÍNDICES OTIMIZADOS ==========

CREATE INDEX IF NOT EXISTS idx_patterns_symbol ON patterns(symbol);
CREATE INDEX IF NOT EXISTS idx_patterns_name ON patterns(name);
CREATE INDEX IF NOT EXISTS idx_patterns_win_rate ON patterns(win_rate DESC);

CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trade_outcomes(symbol);
CREATE INDEX IF NOT EXISTS idx_trades_ts ON trade_outcomes(timestamp);
CREATE INDEX IF NOT EXISTS idx_trades_symbol_side_ts ON trade_outcomes(symbol, side, timestamp);
CREATE INDEX IF NOT EXISTS idx_trades_btc_regime ON trade_outcomes(btc_regime);
CREATE INDEX IF NOT EXISTS idx_trades_pnl ON trade_outcomes(pnl_pct);

CREATE INDEX IF NOT EXISTS idx_observations_symbol ON observations(symbol);
CREATE INDEX IF NOT EXISTS idx_observations_category_ts ON observations(category, timestamp);
CREATE INDEX IF NOT EXISTS idx_observations_confidence ON observations(confidence DESC);

CREATE INDEX IF NOT EXISTS idx_snapshots_symbol_ts ON feature_snapshots(symbol, timestamp);
CREATE INDEX IF NOT EXISTS idx_snapshots_btc_regime ON feature_snapshots(btc_regime);

CREATE INDEX IF NOT EXISTS idx_signal_context ON signal_outcomes(context_key, side);
CREATE INDEX IF NOT EXISTS idx_signal_symbol_ts ON signal_outcomes(symbol, created_at);
CREATE INDEX IF NOT EXISTS idx_signal_finalized ON signal_outcomes(finalized, created_at);
CREATE INDEX IF NOT EXISTS idx_news_expires ON news_events(expires_at);
CREATE INDEX IF NOT EXISTS idx_news_impact ON news_events(impact_score DESC);

-- Novos índices
CREATE INDEX IF NOT EXISTS idx_hourly_metrics_symbol ON hourly_metrics(symbol, hour_utc);
CREATE INDEX IF NOT EXISTS idx_hourly_metrics_date ON hourly_metrics(date);

CREATE INDEX IF NOT EXISTS idx_daily_metrics_symbol ON daily_symbol_metrics(symbol, side, date);
CREATE INDEX IF NOT EXISTS idx_daily_metrics_win_rate ON daily_symbol_metrics(win_rate DESC);

CREATE INDEX IF NOT EXISTS idx_regime_performance ON regime_performance(btc_regime, symbol);

CREATE INDEX IF NOT EXISTS idx_hour_toxicity ON hour_toxicity(symbol, hour_utc, toxicity_score DESC);

CREATE INDEX IF NOT EXISTS idx_rolling_edge ON rolling_edge(symbol, side, computed_at);

CREATE INDEX IF NOT EXISTS idx_execution_quality ON execution_quality(symbol, timestamp);
CREATE INDEX IF NOT EXISTS idx_execution_slippage ON execution_quality(slippage_bps DESC);

-- ========== VIEWS MATERIALIZADAS (via queries otimizadas) ==========
"""


def _get_cache_key(query: str, params: tuple) -> str:
    """Gera chave de cache para query."""
    return f"{query}|{params}"


def _cache_get(query: str, params: tuple) -> Optional[Any]:
    """Recupera do cache se não expirou."""
    key = _get_cache_key(query, params)
    if key in _query_cache:
        value, timestamp = _query_cache[key]
        if time.time() - timestamp < _CACHE_TTL_SECONDS:
            return value
        del _query_cache[key]
    return None


def _cache_set(query: str, params: tuple, value: Any):
    """Armazena no cache."""
    key = _get_cache_key(query, params)
    _query_cache[key] = (value, time.time())
    while len(_query_cache) > _CACHE_MAX_SIZE:
        _query_cache.popitem(last=False)


async def init_db():
    """Inicializa banco com todas as tabelas e migrações."""
    async with connect(DB_PATH) as db:
        await db.executescript(CREATE_TABLES)

        # Migrações para tabelas existentes
        columns = await table_columns("signal_outcomes", DB_PATH)
        migrations = {
            "decision_group": "TEXT NOT NULL DEFAULT 'WAIT'",
            "source_type": "TEXT NOT NULL DEFAULT 'hypothetical'",
            "strategy_version": "TEXT NOT NULL DEFAULT 'legacy'",
            "config_hash": "TEXT NOT NULL DEFAULT ''",
            "estimated_cost_pct": "REAL NOT NULL DEFAULT 0",
            "target_configured_move_pct": "REAL",
            "hit_configured": "INTEGER",
            "first_event": "TEXT",
            "first_event_seconds": "REAL",
        }
        for name, definition in migrations.items():
            if name not in columns:
                await db.execute(f"ALTER TABLE signal_outcomes ADD COLUMN {name} {definition}")

        # Migrações para trade_outcomes (campos novos)
        trade_columns = await table_columns("trade_outcomes", DB_PATH)
        trade_migrations = {
            "source_id": "TEXT",
            "source": "TEXT DEFAULT 'manual'",
            "is_demo": "INTEGER DEFAULT 0",
            "pnl_usdt": "REAL",
            "slippage_bps": "REAL DEFAULT 0",
            "fee_paid_usdt": "REAL DEFAULT 0",
            "experiment_id": "TEXT",
            "experiment_arm": "TEXT",
            "policy_version": "TEXT",
            "campaign_id": "TEXT",
            "exit_reason": "TEXT",
            "latency_drag_usdt": "REAL DEFAULT 0",
            # Exit intelligence fields — added via migration for existing DBs
            "mfe_pct": "REAL",
            "mae_pct": "REAL",
            "gave_back_pct": "REAL",
            "exit_quality": "TEXT",
            "exit_action_taken": "TEXT",
            "entry_aggressive_score": "REAL",
            "execution_priority": "REAL",
            "coach_score": "REAL",
            "playbook_score": "REAL",
            "ml_probability": "REAL",
            "execution_quality": "REAL",
            "signal_id": "TEXT",
            "regime": "TEXT",
            "playbook": "TEXT",
            "setup_type": "TEXT",
            "regime_confidence": "REAL",
            "playbook_version": "TEXT",
            "stacking_depth": "INTEGER DEFAULT 1",
            "risk_tier": "TEXT",
            "size_multiplier": "REAL",
            "size_reason": "TEXT",
            "recommended_margin": "REAL",
            "recommended_leverage": "REAL",
            "max_loss_if_stop": "REAL",
            "notional": "REAL",
        }
        for name, definition in trade_migrations.items():
            if name not in trade_columns:
                await db.execute(f"ALTER TABLE trade_outcomes ADD COLUMN {name} {definition}")

        # Migrações para feature_snapshots
        feature_columns = await table_columns("feature_snapshots", DB_PATH)
        feature_migrations = {
            "bid_depth_5": "REAL",
            "ask_depth_5": "REAL",
            "book_imbalance": "REAL",
            "cvd": "REAL",
            "bid": "REAL",
            "ask": "REAL",
        }
        for name, definition in feature_migrations.items():
            if name not in feature_columns:
                await db.execute(f"ALTER TABLE feature_snapshots ADD COLUMN {name} {definition}")

        # Migrações para signal_outcomes
        signal_columns = await table_columns("signal_outcomes", DB_PATH)
        signal_migrations = {
            "market_event_id": "TEXT",
        }
        for name, definition in signal_migrations.items():
            if name not in signal_columns:
                await db.execute(f"ALTER TABLE signal_outcomes ADD COLUMN {name} {definition}")

        await db.execute(
            "CREATE INDEX IF NOT EXISTS idx_signal_decision_group "
            "ON signal_outcomes(decision_group, finalized)"
        )
        await db.execute(
            "CREATE INDEX IF NOT EXISTS idx_signal_hit_rate "
            "ON signal_outcomes(hit_configured)"
        )
        await db.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_trade_source_id "
            "ON trade_outcomes(source_id)"
        )
        await db.execute(
            "CREATE INDEX IF NOT EXISTS idx_trade_experiment "
            "ON trade_outcomes(experiment_id, experiment_arm, timestamp)"
        )
        await db.execute(
            "CREATE INDEX IF NOT EXISTS idx_trades_playbook_ts "
            "ON trade_outcomes(playbook, timestamp)"
        )

        # ── Signal lifecycle events (DEMO_LEARNING_AGGRESSIVE tracking) ──────
        # Use executescript() so PostgresConnection._postgres_ddl() translates
        # "INTEGER PRIMARY KEY AUTOINCREMENT" → "BIGSERIAL PRIMARY KEY" for PG.
        await db.executescript(
            """CREATE TABLE IF NOT EXISTS signal_lifecycle_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                signal_id TEXT,
                event_type TEXT NOT NULL,
                symbol TEXT NOT NULL,
                side TEXT NOT NULL,
                score REAL,
                risk_profile TEXT,
                is_demo INTEGER DEFAULT 1,
                metadata TEXT,
                ts REAL NOT NULL
            )"""
        )
        await db.execute(
            "CREATE INDEX IF NOT EXISTS idx_lifecycle_signal "
            "ON signal_lifecycle_events(signal_id)"
        )
        await db.execute(
            "CREATE INDEX IF NOT EXISTS idx_lifecycle_type_ts "
            "ON signal_lifecycle_events(event_type, ts)"
        )
        await db.execute(
            "CREATE INDEX IF NOT EXISTS idx_lifecycle_symbol_ts "
            "ON signal_lifecycle_events(symbol, ts)"
        )

        # ── Exit Intelligence tables ──────────────────────────────────────────
        # exit_outcomes: post-trade analysis record (1 per closed demo trade)
        # exit_evaluations: every QB exit recommendation (many per trade lifecycle)
        await db.executescript(
            """CREATE TABLE IF NOT EXISTS exit_outcomes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source_id TEXT UNIQUE,
                symbol TEXT NOT NULL,
                side TEXT NOT NULL,
                is_demo INTEGER DEFAULT 1,
                entry_price REAL,
                exit_price REAL,
                pnl_pct REAL,
                mfe_pct REAL,
                mae_pct REAL,
                gave_back_pct REAL,
                age_seconds REAL,
                tp_pct REAL,
                sl_pct REAL,
                exit_quality TEXT,
                exit_reason TEXT,
                exit_action_taken TEXT,
                entry_aggressive_score REAL,
                btc_regime TEXT,
                hour_utc INTEGER,
                campaign_id TEXT,
                experiment_id TEXT,
                experiment_arm TEXT,
                policy_version TEXT,
                ts REAL NOT NULL
            )"""
        )
        exit_columns = await table_columns("exit_outcomes", DB_PATH)
        exit_migrations = {
            "experiment_id": "TEXT",
            "experiment_arm": "TEXT",
            "policy_version": "TEXT",
        }
        for name, definition in exit_migrations.items():
            if name not in exit_columns:
                await db.execute(f"ALTER TABLE exit_outcomes ADD COLUMN {name} {definition}")
        await db.executescript(
            """CREATE TABLE IF NOT EXISTS exit_evaluations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source_id TEXT,
                symbol TEXT NOT NULL,
                side TEXT NOT NULL,
                action TEXT NOT NULL,
                confidence REAL,
                reason TEXT,
                suggested_stop_pct REAL,
                suggested_tp_pct REAL,
                should_close INTEGER DEFAULT 0,
                should_stack INTEGER DEFAULT 1,
                protection_level TEXT,
                unrealized_pnl_pct REAL,
                mfe_pct REAL,
                age_seconds REAL,
                momentum_score REAL,
                ts REAL NOT NULL
            )"""
        )
        await db.execute(
            "CREATE INDEX IF NOT EXISTS idx_exit_outcomes_symbol_ts "
            "ON exit_outcomes(symbol, ts)"
        )
        await db.execute(
            "CREATE INDEX IF NOT EXISTS idx_exit_outcomes_quality "
            "ON exit_outcomes(exit_quality)"
        )
        await db.execute(
            "CREATE INDEX IF NOT EXISTS idx_exit_evaluations_source "
            "ON exit_evaluations(source_id)"
        )

        await db.commit()


async def record_trade_outcome(
    symbol: str, side: str, pnl_pct: float,
    source_id: str | None = None,
    source: str = "manual", is_demo: bool = False,
    entry_price: float = 0.0, exit_price: float = 0.0,
    oi_change: float = 0.0, funding: float = 0.0,
    volume_ratio: float = 1.0, btc_regime: str = "NEUTRAL",
    rsi: float = 50.0, ema_cross: str = "FLAT",
    pnl_usdt: float = 0.0, slippage_bps: float = 0.0,
    fee_paid_usdt: float = 0.0,
    experiment_id: str = "",
    experiment_arm: str = "",
    policy_version: str = "",
    campaign_id: str = "",
    mfe_pct: float = 0.0,
    mae_pct: float = 0.0,
    exit_reason: str = "",
    latency_drag_usdt: float = 0.0,
    regime: str | None = None,
    playbook: str | None = None,
    setup_type: str | None = None,
    regime_confidence: float | None = None,
    playbook_version: str | None = None,
    stacking_depth: int = 1,
    execution_priority: float | None = None,
    coach_score: float | None = None,
    playbook_score: float | None = None,
    ml_probability: float | None = None,
    execution_quality: float | None = None,
    signal_id: str = "",
    entry_aggressive_score: float | None = None,
    risk_tier: str | None = None,
    size_multiplier: float | None = None,
    size_reason: str | None = None,
    recommended_margin: float | None = None,
    recommended_leverage: float | None = None,
    max_loss_if_stop: float | None = None,
    notional: float | None = None,
) -> bool:
    """Registra outcome de trade com métricas avançadas."""
    win = 1 if pnl_pct > 0 else 0
    async with connect(DB_PATH) as db:
        if source_id:
            existing = await (await db.execute(
                "SELECT id FROM trade_outcomes WHERE source_id=?",
                (source_id,),
            )).fetchone()
            if existing:
                await db.execute(
                    """UPDATE trade_outcomes
                       SET source=?, is_demo=?, symbol=?, side=?, entry_price=?, exit_price=?,
                           pnl_pct=?, pnl_usdt=?, win=?, oi_at_entry=?, funding_at_entry=?,
                           volume_ratio=?, btc_regime=?, rsi_at_entry=?, ema_cross=?,
                           slippage_bps=?, fee_paid_usdt=?, experiment_id=?, experiment_arm=?,
                           policy_version=?, campaign_id=?, mfe_pct=?, mae_pct=?,
                           exit_reason=?, latency_drag_usdt=?, regime=?, playbook=?,
                           setup_type=?, regime_confidence=?, playbook_version=?,
                           stacking_depth=?, execution_priority=?, coach_score=?,
                           playbook_score=?, ml_probability=?, execution_quality=?,
                           signal_id=?, entry_aggressive_score=?, risk_tier=?,
                           size_multiplier=?, size_reason=?, recommended_margin=?,
                           recommended_leverage=?, max_loss_if_stop=?, notional=?,
                           timestamp=?
                       WHERE source_id=?""",
                    (source, 1 if is_demo else 0, symbol, side, entry_price, exit_price,
                     pnl_pct, pnl_usdt, win, oi_change, funding,
                     volume_ratio, btc_regime, rsi, ema_cross,
                     slippage_bps, fee_paid_usdt, experiment_id, experiment_arm,
                     policy_version, campaign_id, mfe_pct, mae_pct, exit_reason,
                     latency_drag_usdt, regime, playbook, setup_type, regime_confidence,
                     playbook_version, stacking_depth, execution_priority, coach_score,
                     playbook_score, ml_probability, execution_quality,
                     signal_id, entry_aggressive_score, risk_tier, size_multiplier,
                     size_reason, recommended_margin, recommended_leverage,
                     max_loss_if_stop, notional, time.time(), source_id)
                )
                await db.commit()
                return True

        cursor = await db.execute(
            """INSERT INTO trade_outcomes
               (source_id, source, is_demo, symbol, side, entry_price, exit_price, pnl_pct, pnl_usdt, win,
                oi_at_entry, funding_at_entry, volume_ratio, btc_regime,
                rsi_at_entry, ema_cross, slippage_bps, fee_paid_usdt,
                experiment_id, experiment_arm, policy_version, campaign_id,
                mfe_pct, mae_pct, exit_reason, latency_drag_usdt,
                regime, playbook, setup_type, regime_confidence, playbook_version,
                stacking_depth, execution_priority, coach_score, playbook_score,
                ml_probability, execution_quality, signal_id, entry_aggressive_score,
                risk_tier, size_multiplier, size_reason, recommended_margin,
                recommended_leverage, max_loss_if_stop, notional,
                timestamp)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(source_id) DO NOTHING""",
            (source_id, source, 1 if is_demo else 0, symbol, side, entry_price, exit_price, pnl_pct, pnl_usdt, win,
             oi_change, funding, volume_ratio, btc_regime,
             rsi, ema_cross, slippage_bps, fee_paid_usdt,
             experiment_id, experiment_arm, policy_version, campaign_id,
             mfe_pct, mae_pct, exit_reason, latency_drag_usdt,
             regime, playbook, setup_type, regime_confidence, playbook_version,
             stacking_depth, execution_priority, coach_score, playbook_score,
             ml_probability, execution_quality, signal_id, entry_aggressive_score,
             risk_tier, size_multiplier, size_reason, recommended_margin,
             recommended_leverage, max_loss_if_stop, notional,
             time.time())
        )
        if source_id and int(getattr(cursor, "rowcount", 0) or 0) == 0:
            return False
        await _update_hourly_metrics(db, symbol, side, pnl_pct, win)
        await _update_daily_metrics(db, symbol, side, pnl_pct, win)
        await db.commit()
        return True


async def _update_hourly_metrics(db: Any, symbol: str, side: str, pnl_pct: float, win: int):
    """Atualiza métricas horárias agregadas."""
    from datetime import datetime, timezone
    now_utc = datetime.now(timezone.utc)
    hour_utc = now_utc.hour
    date = now_utc.strftime("%Y-%m-%d")

    await db.execute(
        """INSERT INTO hourly_metrics (symbol, hour_utc, date, trades, wins, total_pnl_pct, avg_pnl_pct, win_rate)
           VALUES (?, ?, ?, 1, ?, ?, ?, ?)
           ON CONFLICT(symbol, date, hour_utc) DO UPDATE SET
               trades = hourly_metrics.trades + 1,
               wins = hourly_metrics.wins + excluded.wins,
               total_pnl_pct = hourly_metrics.total_pnl_pct + excluded.total_pnl_pct,
               avg_pnl_pct = (
                   hourly_metrics.total_pnl_pct + excluded.total_pnl_pct
               ) / (hourly_metrics.trades + 1),
               win_rate = CAST(
                   hourly_metrics.wins + excluded.wins AS REAL
               ) / (hourly_metrics.trades + 1)""",
        (symbol, hour_utc, date, win, pnl_pct, pnl_pct, pnl_pct if win else 0)
    )


async def _update_daily_metrics(db: Any, symbol: str, side: str, pnl_pct: float, win: int):
    """Atualiza métricas diárias agregadas."""
    from datetime import datetime, timezone
    date = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    await db.execute(
        """INSERT INTO daily_symbol_metrics (symbol, side, date, trades, wins, total_pnl_pct, avg_pnl_pct, win_rate)
           VALUES (?, ?, ?, 1, ?, ?, ?, ?)
           ON CONFLICT(symbol, side, date) DO UPDATE SET
               trades = daily_symbol_metrics.trades + 1,
               wins = daily_symbol_metrics.wins + excluded.wins,
               total_pnl_pct = daily_symbol_metrics.total_pnl_pct + excluded.total_pnl_pct,
               avg_pnl_pct = (
                   daily_symbol_metrics.total_pnl_pct + excluded.total_pnl_pct
               ) / (daily_symbol_metrics.trades + 1),
               win_rate = CAST(
                   daily_symbol_metrics.wins + excluded.wins AS REAL
               ) / (daily_symbol_metrics.trades + 1)""",
        (symbol, side, date, win, pnl_pct, pnl_pct, pnl_pct if win else 0)
    )


async def save_feature_snapshot(symbol: str, features: dict):
    """Salva snapshot de features com campos avançados, incluindo bid/ask para
    que o fallback de sinal_learning possa reconstruir preços executáveis."""
    async with connect(DB_PATH) as db:
        await db.execute(
            """INSERT INTO feature_snapshots
               (symbol, timestamp, price, bid, ask, price_change_pct, volume_ratio,
                oi_change_pct, funding_rate, rsi, ema_cross, atr_pct,
                spread_bps, btc_regime, bid_depth_5, ask_depth_5, book_imbalance, cvd)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                symbol, time.time(),
                features.get("price", 0),
                features.get("bid") or features.get("price", 0),
                features.get("ask") or features.get("price", 0),
                features.get("price_change_pct", 0),
                features.get("volume_ratio", 1),
                features.get("oi_change_pct", 0),
                features.get("funding_rate", 0),
                features.get("rsi", 50),
                features.get("ema_cross", "FLAT"),
                features.get("atr_pct", 0),
                features.get("spread_bps", 0),
                features.get("btc_regime", "NEUTRAL"),
                features.get("bid_depth_5", 0),
                features.get("ask_depth_5", 0),
                features.get("book_imbalance", 0),
                features.get("cvd", 0),
            )
        )
        await db.commit()


async def record_signal_decision(
    signal_id: str,
    symbol: str,
    side: str,
    decision: str,
    decision_group: str,
    source_type: str,
    strategy_version: str,
    config_hash: str,
    context_key: str,
    features: dict,
    reasons: list,
    entry_price: float,
    estimated_cost_pct: float,
    target_moves: dict[str, float],
) -> bool:
    if entry_price <= 0:
        return False
    async with connect(DB_PATH) as db:
        try:
            await db.execute(
                """INSERT INTO signal_outcomes
                   (signal_id, symbol, side, decision, decision_group, source_type,
                    strategy_version, config_hash, context_key, features, reasons,
                    entry_price, estimated_cost_pct,
                    target_configured_move_pct, target_050_move_pct,
                    target_100_move_pct, target_200_move_pct,
                    created_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    signal_id,
                    symbol,
                    side,
                    decision,
                    decision_group,
                    source_type,
                    strategy_version,
                    config_hash,
                    context_key,
                    json.dumps(features),
                    json.dumps(reasons),
                    entry_price,
                    estimated_cost_pct,
                    float(target_moves.get("configured", 0)),
                    float(target_moves.get("0.5", 0)),
                    float(target_moves.get("1.0", 0)),
                    float(target_moves.get("2.0", 0)),
                    time.time(),
                ),
            )
            await db.commit()
            return True
        except IntegrityError:
            return False


async def get_pending_signal_outcomes(min_age_seconds: int = 300, limit: int = 200) -> list[dict]:
    cutoff = time.time() - min_age_seconds
    async with connect(DB_PATH) as db:
        db.row_factory = Row
        rows = await (await db.execute(
            """SELECT * FROM signal_outcomes
               WHERE finalized=0 AND created_at <= ?
               ORDER BY created_at ASC
               LIMIT ?""",
            (cutoff, limit),
        )).fetchall()
        result = []
        for r in rows:
            d = dict(r)
            d["features"] = json.loads(d["features"])
            d["reasons"] = json.loads(d["reasons"])
            result.append(d)
        return result


async def finalize_signal_outcome(
    signal_id: str,
    prices: dict[str, float],
    hits: dict[str, bool],
    stopped: bool,
    first_event: str | None,
    first_event_seconds: float | None,
    max_favorable_pct: float,
    max_adverse_pct: float,
) -> None:
    async with connect(DB_PATH) as db:
        await db.execute(
            """UPDATE signal_outcomes
               SET price_30s=?, price_60s=?, price_120s=?, price_300s=?,
                   hit_configured=?, hit_050=?, hit_100=?, hit_200=?, stopped=?,
                   first_event=?, first_event_seconds=?,
                   max_favorable_pct=?, max_adverse_pct=?,
                   finalized=1, finalized_at=?
               WHERE signal_id=?""",
            (
                prices.get("30"),
                prices.get("60"),
                prices.get("120"),
                prices.get("300"),
                1 if hits.get("configured") else 0,
                1 if hits.get("0.5") else 0,
                1 if hits.get("1.0") else 0,
                1 if hits.get("2.0") else 0,
                1 if stopped else 0,
                first_event,
                first_event_seconds,
                max_favorable_pct,
                max_adverse_pct,
                time.time(),
                signal_id,
            ),
        )
        await db.commit()


async def get_signal_edge_stats(
    symbol: str,
    side: str,
    context_key: str | None = None,
    decision_group: str = "ALLOW",
    source_type: str = "hypothetical",
    days: int = 14,
) -> dict:
    since = time.time() - days * 86400
    params: list = [side, since, decision_group, source_type]
    where = (
        "WHERE finalized=1 AND side=? AND created_at >= ? "
        "AND decision_group=? AND source_type=? AND hit_configured IS NOT NULL"
    )
    if context_key:
        where += " AND context_key=?"
        params.append(context_key)
    else:
        where += " AND symbol=?"
        params.append(symbol)

    async with connect(DB_PATH) as db:
        db.row_factory = Row
        row = await (await db.execute(
            f"""SELECT COUNT(*) as samples,
                       AVG(hit_configured) as hit_configured,
                       AVG(hit_050) as hit_050,
                       AVG(hit_100) as hit_100,
                       AVG(hit_200) as hit_200,
                       AVG(stopped) as stop_rate,
                       AVG(max_favorable_pct) as avg_favorable_pct,
                       AVG(max_adverse_pct) as avg_adverse_pct
                FROM signal_outcomes
                {where}""",
            params,
        )).fetchone()
    d = dict(row) if row else {}
    samples = int(d.get("samples") or 0)
    return {
        "samples": samples,
        "hit_configured": round(float(d.get("hit_configured") or 0), 4),
        "hit_050": round(float(d.get("hit_050") or 0), 4),
        "hit_100": round(float(d.get("hit_100") or 0), 4),
        "hit_200": round(float(d.get("hit_200") or 0), 4),
        "stop_rate": round(float(d.get("stop_rate") or 0), 4),
        "avg_favorable_pct": round(float(d.get("avg_favorable_pct") or 0), 4),
        "avg_adverse_pct": round(float(d.get("avg_adverse_pct") or 0), 4),
    }


async def get_signal_training_rows(
    decision_group: str | None = None,
    source_type: str | None = "hypothetical",
    limit: int = 50000,
) -> list[dict]:
    decision_filter = ""
    source_filter = ""
    params: list[Any] = []
    if source_type:
        source_filter = "AND source_type=?"
        params.append(source_type)
    if decision_group:
        decision_filter = " AND decision_group=?"
        params.append(decision_group)
    params.append(limit)
    async with connect(DB_PATH) as db:
        db.row_factory = Row
        rows = await (await db.execute(
            f"""SELECT signal_id, symbol, side, decision, decision_group,
                      context_key, features,
                      target_configured_move_pct, estimated_cost_pct, hit_configured,
                      stopped, first_event, created_at
               FROM signal_outcomes
               WHERE finalized=1
                 {source_filter}
                 AND hit_configured IS NOT NULL
                 {decision_filter}
               ORDER BY created_at ASC
               LIMIT ?""",
            params,
        )).fetchall()
    result = []
    for row in rows:
        item = dict(row)
        item["features"] = json.loads(item["features"])
        result.append(item)
    return result


async def get_signal_training_summary(
    decision_group: str | None = None,
    source_type: str | None = "hypothetical",
) -> dict:
    decision_filter = ""
    source_filter = ""
    params: list[Any] = []
    if source_type:
        source_filter = "AND source_type=?"
        params.append(source_type)
    if decision_group:
        decision_filter = " AND decision_group=?"
        params.append(decision_group)
    async with connect(DB_PATH) as db:
        row = await (await db.execute(
            f"""SELECT COUNT(*) AS samples,
                      SUM(CASE WHEN hit_configured=1 THEN 1 ELSE 0 END) AS hits,
                      SUM(CASE WHEN hit_configured=0 THEN 1 ELSE 0 END) AS misses,
                      MAX(created_at) AS latest_created_at
               FROM signal_outcomes
               WHERE finalized=1
                 {source_filter}
                 AND hit_configured IS NOT NULL
                 {decision_filter}""",
            params,
        )).fetchone()

    values = row or (0, 0, 0, 0)
    samples = int(values[0] or 0)
    hits = int(values[1] or 0)
    misses = int(values[2] or 0)
    return {
        "samples": samples,
        "hits": hits,
        "misses": misses,
        "hasBothClasses": hits > 0 and misses > 0,
        "latestCreatedAt": float(values[3] or 0),
    }


async def get_signal_pipeline_summary() -> dict:
    async with connect(DB_PATH) as db:
        row = await (await db.execute(
            """SELECT COUNT(*) AS observed,
                      SUM(CASE WHEN finalized=0 THEN 1 ELSE 0 END) AS pending,
                      SUM(CASE WHEN finalized=1 THEN 1 ELSE 0 END) AS finalized,
                      SUM(CASE WHEN decision_group='ALLOW' THEN 1 ELSE 0 END) AS allowed,
                      SUM(CASE WHEN decision_group='WAIT' THEN 1 ELSE 0 END) AS waited,
                      SUM(CASE WHEN decision_group='BLOCK' THEN 1 ELSE 0 END) AS blocked
               FROM signal_outcomes"""
        )).fetchone()

    values = row or (0, 0, 0, 0, 0, 0)
    return {
        "observed": int(values[0] or 0),
        "pending": int(values[1] or 0),
        "finalized": int(values[2] or 0),
        "allowed": int(values[3] or 0),
        "waited": int(values[4] or 0),
        "blocked": int(values[5] or 0),
    }


async def get_recent_signal_outcomes(limit: int = 20, source_type: str | None = None) -> list[dict]:
    params: list[Any] = []
    source_filter = ""
    if source_type:
        source_filter = "WHERE source_type=?"
        params.append(source_type)
    params.append(limit)
    async with connect(DB_PATH) as db:
        db.row_factory = Row
        rows = await (await db.execute(
            f"""SELECT signal_id, symbol, side, decision, decision_group, source_type,
                      context_key, hit_configured, stopped, first_event,
                      max_favorable_pct, max_adverse_pct, created_at, finalized
               FROM signal_outcomes
               {source_filter}
               ORDER BY created_at DESC
               LIMIT ?""",
            params,
        )).fetchall()
    return [dict(row) for row in rows]


async def get_signal_source_summary() -> list[dict]:
    async with connect(DB_PATH) as db:
        rows = await (await db.execute(
            """SELECT source_type,
                      COUNT(*) AS observed,
                      SUM(CASE WHEN finalized=0 THEN 1 ELSE 0 END) AS pending,
                      SUM(CASE WHEN finalized=1 THEN 1 ELSE 0 END) AS finalized,
                      SUM(CASE WHEN hit_configured=1 THEN 1 ELSE 0 END) AS hits,
                      SUM(CASE WHEN hit_configured=0 THEN 1 ELSE 0 END) AS misses,
                      MAX(created_at) AS latest_created_at
               FROM signal_outcomes
               GROUP BY source_type
               ORDER BY observed DESC"""
        )).fetchall()
    return [
        {
            "sourceType": str(row[0] or "unknown"),
            "observed": int(row[1] or 0),
            "pending": int(row[2] or 0),
            "finalized": int(row[3] or 0),
            "hits": int(row[4] or 0),
            "misses": int(row[5] or 0),
            "latestCreatedAt": float(row[6] or 0),
        }
        for row in rows
    ]


async def save_model_artifact(
    name: str,
    content: bytes,
    metadata: dict,
) -> None:
    async with connect(DB_PATH) as db:
        await db.execute(
            """INSERT INTO model_artifacts (name, content, metadata, updated_at)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(name) DO UPDATE SET
                   content=excluded.content,
                   metadata=excluded.metadata,
                   updated_at=excluded.updated_at""",
            (name, content, json.dumps(metadata), time.time()),
        )
        await db.commit()


async def get_model_artifact(name: str) -> dict | None:
    async with connect(DB_PATH) as db:
        row = await (await db.execute(
            """SELECT content, metadata, updated_at
               FROM model_artifacts WHERE name=?""",
            (name,),
        )).fetchone()
    if not row:
        return None
    return {
        "content": bytes(row[0]),
        "metadata": json.loads(row[1]),
        "updatedAt": float(row[2]),
    }


async def cleanup_retention(now: float | None = None) -> dict[str, int]:
    current = now or time.time()
    policies = {
        "feature_snapshots": (
            "timestamp",
            int(os.environ.get("RETENTION_FEATURE_SNAPSHOTS_HOURS", "24")) * 3600,
        ),
        "signal_outcomes": (
            "created_at",
            int(os.environ.get("RETENTION_SIGNAL_OUTCOMES_DAYS", "60")) * 86400,
        ),
        "news_events": (
            "expires_at",
            int(os.environ.get("RETENTION_NEWS_EVENTS_DAYS", "3")) * 86400,
        ),
        "observations": (
            "timestamp",
            int(os.environ.get("RETENTION_OBSERVATIONS_DAYS", "14")) * 86400,
        ),
        "execution_quality": (
            "timestamp",
            int(os.environ.get("RETENTION_EXECUTION_QUALITY_DAYS", "14")) * 86400,
        ),
    }
    trade_days = int(os.environ.get("RETENTION_TRADE_OUTCOMES_DAYS", "0"))
    if trade_days > 0:
        policies["trade_outcomes"] = ("timestamp", trade_days * 86400)
    deleted: dict[str, int] = {}
    async with connect(DB_PATH) as db:
        for table, (column, age_seconds) in policies.items():
            cutoff = current - age_seconds
            cursor = await db.execute(
                f"DELETE FROM {table} WHERE {column} < ?",
                (cutoff,),
            )
            deleted[table] = int(getattr(cursor, "rowcount", 0) or 0)
        await db.commit()
    _query_cache.clear()
    return deleted


async def get_trade_source_summary() -> dict:
    async with connect(DB_PATH) as db:
        rows = await (await db.execute(
            """SELECT COALESCE(source, 'manual') AS source,
                      COALESCE(is_demo, 0) AS is_demo,
                      COUNT(*) AS trades,
                      SUM(CASE WHEN win=1 THEN 1 ELSE 0 END) AS wins,
                      SUM(COALESCE(pnl_usdt, 0)) AS pnl_usdt,
                      SUM(CASE WHEN COALESCE(pnl_usdt, 0) > 0 THEN pnl_usdt ELSE 0 END) AS positive_pnl_usdt,
                      SUM(CASE WHEN COALESCE(pnl_usdt, 0) < 0 THEN pnl_usdt ELSE 0 END) AS negative_pnl_usdt,
                      MAX(timestamp) AS last_trade_at
               FROM trade_outcomes
               GROUP BY COALESCE(source, 'manual'), COALESCE(is_demo, 0)
               ORDER BY trades DESC"""
        )).fetchall()
    sources = [
        {
            "source": str(row[0]),
            "isDemo": bool(row[1]),
            "trades": int(row[2] or 0),
            "wins": int(row[3] or 0),
            "losses": int(row[2] or 0) - int(row[3] or 0),
            "pnlUsdt": round(float(row[4] or 0), 8),
            "positivePnlUsdt": round(float(row[5] or 0), 8),
            "negativePnlUsdt": round(float(row[6] or 0), 8),
            "lastTradeAt": float(row[7] or 0),
        }
        for row in rows
    ]
    return {
        "totalTrades": sum(item["trades"] for item in sources),
        "demoTrades": sum(item["trades"] for item in sources if item["isDemo"]),
        "liveTrades": sum(item["trades"] for item in sources if not item["isDemo"]),
        "sources": sources,
    }


async def get_recent_trade_outcomes(source: str = "all", limit: int = 500) -> list[dict]:
    source = (source or "all").lower()
    limit = max(1, min(int(limit or 500), 2000))
    where = ""
    params: list[Any] = []
    if source == "demo":
        where = "WHERE COALESCE(is_demo, 0)=1 OR COALESCE(source, '')='bingx-vst'"
    elif source == "live":
        where = "WHERE COALESCE(is_demo, 0)=0 AND COALESCE(source, '')!='bingx-vst'"

    params.append(limit)
    async with connect(DB_PATH) as db:
        rows = await (await db.execute(
            f"""SELECT id, source_id, COALESCE(source, 'manual') AS source,
                      COALESCE(is_demo, 0) AS is_demo,
                      symbol, side, entry_price, exit_price, pnl_pct,
                      pnl_usdt, win, btc_regime, slippage_bps,
                      fee_paid_usdt, timestamp, experiment_id, experiment_arm,
                      policy_version, campaign_id, mfe_pct, mae_pct, exit_reason,
                      latency_drag_usdt, risk_tier, size_multiplier, size_reason,
                      recommended_margin, recommended_leverage, max_loss_if_stop,
                      notional
               FROM trade_outcomes
               {where}
               ORDER BY timestamp DESC
               LIMIT ?""",
            tuple(params),
        )).fetchall()

    outcomes: list[dict] = []
    for row in rows:
        pnl_pct = float(row[8] or 0)
        pnl_usdt = float(row[9] or 0)
        fee = abs(float(row[13] or 0))
        margin_used = abs(pnl_usdt / (pnl_pct / 100)) if pnl_pct else 1.0
        if margin_used <= 0:
            margin_used = 1.0
        source_name = str(row[2] or "manual")
        is_demo = bool(row[3]) or source_name == "bingx-vst"
        side = str(row[5] or "LONG").upper()
        position_side = "SHORT" if side == "SHORT" else "LONG"
        timestamp = float(row[14] or 0)
        entry_price = float(row[6] or 0) or 1.0
        exit_price = float(row[7] or 0) or entry_price
        outcomes.append({
            "id": str(row[1] or f"quant-{row[0]}"),
            "source": source_name,
            "isDemo": is_demo,
            "symbol": str(row[4]),
            "positionSide": position_side,
            "side": "SELL" if position_side == "SHORT" else "BUY",
            "entryTime": timestamp,
            "exitTime": timestamp,
            "hourUtc": int(time.gmtime(timestamp).tm_hour) if timestamp > 0 else 0,
            "btcRegime": str(row[11] or "NEUTRAL"),
            "entryPrice": entry_price,
            "exitPrice": exit_price,
            "qty": 1.0,
            "leverage": 1.0,
            "marginUsed": round(margin_used, 8),
            "grossPnl": round(pnl_usdt + fee, 8),
            "fee": fee,
            "realizedPnl": pnl_usdt,
            "pnlSource": "balance_delta",
            "estimated": False,
            "entrySlippage": 0.0,
            "exitSlippage": 0.0,
            "totalSlippage": 0.0,
            "slippagePctNotional": abs(float(row[12] or 0)) / 10000,
            "exitReason": "TP" if pnl_usdt > 0 else "SL" if pnl_usdt < 0 else "MANUAL",
            "expectedTpProfit": abs(pnl_usdt),
            "experimentId": str(row[15] or ""),
            "experimentArm": str(row[16] or ""),
            "policyVersion": str(row[17] or ""),
            "campaignId": str(row[18] or ""),
            "mfePct": float(row[19] or 0),
            "maePct": float(row[20] or 0),
            "experimentExitReason": str(row[21] or ""),
            "latencyDragUsdt": float(row[22] or 0),
            "riskTier": row[23],
            "sizeMultiplier": float(row[24]) if row[24] is not None else None,
            "sizeReason": row[25],
            "recommendedMargin": float(row[26]) if row[26] is not None else None,
            "recommendedLeverage": float(row[27]) if row[27] is not None else None,
            "maxLossIfStop": float(row[28]) if row[28] is not None else None,
            "notional": float(row[29]) if row[29] is not None else None,
        })
    return outcomes


async def get_score_calibration_rows(days: int = 30, limit: int = 5000) -> list[dict]:
    since = time.time() - max(1, int(days or 30)) * 86400
    limit = max(1, min(int(limit or 5000), 20000))
    async with connect(DB_PATH) as db:
        rows = await (await db.execute(
            """SELECT source_id, signal_id, symbol, side, pnl_usdt, pnl_pct, win,
                      btc_regime, COALESCE(regime, btc_regime) AS regime,
                      slippage_bps, latency_drag_usdt, timestamp,
                      experiment_id, experiment_arm, policy_version, campaign_id,
                      mfe_pct, mae_pct, exit_reason, exit_quality,
                      entry_aggressive_score, execution_priority, coach_score,
                      playbook_score, playbook, ml_probability, execution_quality
               FROM trade_outcomes
               WHERE timestamp >= ?
               ORDER BY timestamp ASC
               LIMIT ?""",
            (since, limit),
        )).fetchall()

    result: list[dict[str, Any]] = []
    for row in rows:
        aggressive = row[20]
        execution_priority = row[21]
        coach_score = row[22]
        playbook_score = row[23]
        ml_probability = row[25]
        result.append({
            "sourceId": row[0],
            "signalId": row[1] or row[0],
            "symbol": row[2],
            "side": row[3],
            "realizedPnl": float(row[4] or 0),
            "pnlPct": float(row[5] or 0),
            "win": bool(row[6]),
            "btcRegime": row[7],
            "regime": row[8] or row[7] or "NEUTRAL",
            "slippageBps": float(row[9] or 0),
            "latencyDragUsdt": float(row[10] or 0),
            "timestamp": float(row[11] or 0),
            "experimentId": row[12],
            "experimentArm": row[13],
            "policyVersion": row[14],
            "campaignId": row[15],
            "mfePct": float(row[16] or 0),
            "maePct": float(row[17] or 0),
            "exitReason": row[18],
            "exitQuality": row[19],
            "aggressiveScore": float(aggressive) if aggressive is not None else None,
            "executionPriority": float(execution_priority) if execution_priority is not None else (
                float(aggressive) if aggressive is not None else None
            ),
            "coachScore": float(coach_score) if coach_score is not None else (
                float(execution_priority) if execution_priority is not None else None
            ),
            "playbookScore": float(playbook_score) if playbook_score is not None else None,
            "playbook": row[24] or "UNKNOWN",
            "mlProbability": float(ml_probability) if ml_probability is not None else None,
            "executionQuality": float(row[26]) if row[26] is not None else None,
        })
    return result


async def get_playbook_performance(days: int = 30) -> dict[str, dict]:
    """Aggregated PnL/win-rate/PF by playbook for sizing and status endpoints."""
    columns = await table_columns("trade_outcomes", DB_PATH)
    if not {"playbook", "stacking_depth"}.issubset(columns):
        return {}
    since = time.time() - max(1, days) * 86400
    async with connect(DB_PATH) as db:
        db.row_factory = Row
        rows = await (await db.execute(
            """SELECT COALESCE(playbook, 'UNKNOWN') AS playbook,
                      COUNT(*) AS trades,
                      SUM(CASE WHEN pnl_pct > 0 THEN 1 ELSE 0 END) AS wins,
                      AVG(pnl_pct) AS avg_pnl_pct,
                      SUM(CASE WHEN pnl_pct > 0 THEN pnl_pct ELSE 0 END) AS gross_profit,
                      SUM(CASE WHEN pnl_pct < 0 THEN ABS(pnl_pct) ELSE 0 END) AS gross_loss,
                      AVG(slippage_bps) AS avg_slippage_bps,
                      AVG(stacking_depth) AS avg_stacking_depth
               FROM trade_outcomes
               WHERE timestamp >= ? AND playbook IS NOT NULL AND playbook != ''
               GROUP BY 1
               ORDER BY trades DESC""",
            (since,),
        )).fetchall()

    performance: dict[str, dict] = {}
    for row in rows:
        d = dict(row)
        trades = int(d.get("trades") or 0)
        gross_loss = float(d.get("gross_loss") or 0.0)
        gross_profit = float(d.get("gross_profit") or 0.0)
        performance[str(d["playbook"])] = {
            "trades": trades,
            "wins": int(d.get("wins") or 0),
            "winRate": round(float(d.get("wins") or 0) / trades, 4) if trades else None,
            "avgPnlPct": round(float(d.get("avg_pnl_pct") or 0.0), 4),
            "profitFactor": round(gross_profit / gross_loss, 4) if gross_loss > 0 else None,
            "avgSlippageBps": round(float(d.get("avg_slippage_bps") or 0.0), 3),
            "avgStackingDepth": round(float(d.get("avg_stacking_depth") or 0.0), 3),
        }
    return performance


async def get_playbook_report(days: int = 30) -> dict:
    columns = await table_columns("trade_outcomes", DB_PATH)
    if not {"playbook", "regime", "stacking_depth", "entry_aggressive_score"}.issubset(columns):
        return {
            "days": days,
            "byPlaybook": [],
            "byRegime": [],
            "bestTpSlByPlaybook": [],
            "scoreBucketsByPlaybook": [],
        }
    since = time.time() - max(1, days) * 86400
    async with connect(DB_PATH) as db:
        db.row_factory = Row
        by_playbook = await (await db.execute(
            """SELECT COALESCE(playbook, 'UNKNOWN') AS playbook,
                      COUNT(*) AS trades,
                      SUM(CASE WHEN pnl_pct > 0 THEN 1 ELSE 0 END) AS wins,
                      AVG(pnl_pct) AS avg_pnl_pct,
                      SUM(CASE WHEN pnl_pct > 0 THEN pnl_pct ELSE 0 END) AS gross_profit,
                      SUM(CASE WHEN pnl_pct < 0 THEN ABS(pnl_pct) ELSE 0 END) AS gross_loss,
                      AVG(slippage_bps) AS avg_slippage_bps,
                      AVG(stacking_depth) AS avg_stacking_depth
               FROM trade_outcomes
               WHERE timestamp >= ? AND playbook IS NOT NULL AND playbook != ''
               GROUP BY 1 ORDER BY trades DESC""",
            (since,),
        )).fetchall()
        by_regime = await (await db.execute(
            """SELECT COALESCE(regime, btc_regime, 'UNKNOWN') AS regime,
                      COUNT(*) AS trades,
                      AVG(pnl_pct) AS avg_pnl_pct,
                      SUM(CASE WHEN pnl_pct > 0 THEN pnl_pct ELSE 0 END) AS gross_profit,
                      SUM(CASE WHEN pnl_pct < 0 THEN ABS(pnl_pct) ELSE 0 END) AS gross_loss
               FROM trade_outcomes
               WHERE timestamp >= ?
               GROUP BY 1 ORDER BY trades DESC""",
            (since,),
        )).fetchall()
        tp_sl = await (await db.execute(
            """SELECT COALESCE(playbook, 'UNKNOWN') AS playbook,
                      COUNT(*) AS trades,
                      AVG(mfe_pct) AS avg_mfe_pct,
                      AVG(mae_pct) AS avg_mae_pct,
                      AVG(stacking_depth) AS avg_stacking_depth
               FROM trade_outcomes
               WHERE timestamp >= ? AND playbook IS NOT NULL AND playbook != ''
               GROUP BY 1 ORDER BY trades DESC""",
            (since,),
        )).fetchall()
        score_buckets = await (await db.execute(
            """SELECT COALESCE(playbook, 'UNKNOWN') AS playbook,
                      CASE
                        WHEN entry_aggressive_score IS NULL THEN 'unknown'
                        WHEN entry_aggressive_score < 0.45 THEN 'low'
                        WHEN entry_aggressive_score < 0.65 THEN 'mid'
                        WHEN entry_aggressive_score < 0.80 THEN 'high'
                        ELSE 'elite'
                      END AS score_bucket,
                      COUNT(*) AS trades,
                      AVG(pnl_pct) AS avg_pnl_pct,
                      SUM(CASE WHEN pnl_pct > 0 THEN 1 ELSE 0 END) * 1.0 / COUNT(*) AS win_rate
               FROM trade_outcomes
               WHERE timestamp >= ? AND playbook IS NOT NULL AND playbook != ''
               GROUP BY 1, 2 ORDER BY 1, 2""",
            (since,),
        )).fetchall()

    def _fmt_profit_factor(row: Row) -> dict:
        d = dict(row)
        trades = int(d.get("trades") or 0)
        gross_loss = float(d.get("gross_loss") or 0.0)
        gross_profit = float(d.get("gross_profit") or 0.0)
        wins = int(d.get("wins") or 0) if "wins" in d else None
        out = {
            k: (round(v, 4) if isinstance(v, float) else v)
            for k, v in d.items()
            if k not in {"gross_profit", "gross_loss"}
        }
        if wins is not None:
            out["winRate"] = round(wins / trades, 4) if trades else None
        out["profitFactor"] = round(gross_profit / gross_loss, 4) if gross_loss > 0 else None
        return out

    return {
        "days": days,
        "byPlaybook": [_fmt_profit_factor(row) for row in by_playbook],
        "byRegime": [_fmt_profit_factor(row) for row in by_regime],
        "bestTpSlByPlaybook": [
            {k: (round(v, 4) if isinstance(v, float) else v) for k, v in dict(row).items()}
            for row in tp_sl
        ],
        "scoreBucketsByPlaybook": [
            {k: (round(v, 4) if isinstance(v, float) else v) for k, v in dict(row).items()}
            for row in score_buckets
        ],
    }


async def get_operational_risk_metrics(hours: int = 24) -> dict:
    since = time.time() - hours * 3600
    async with connect(DB_PATH) as db:
        rows = await (await db.execute(
            """SELECT pnl_pct, timestamp
               FROM trade_outcomes
               WHERE timestamp >= ?
               ORDER BY timestamp ASC""",
            (since,),
        )).fetchall()
    cumulative = 0.0
    peak = 0.0
    max_drawdown = 0.0
    consecutive_losses = 0
    current_losses = 0
    for pnl_pct, _ in rows:
        pnl = float(pnl_pct or 0)
        cumulative += pnl
        peak = max(peak, cumulative)
        max_drawdown = max(max_drawdown, peak - cumulative)
        if pnl < 0:
            current_losses += 1
            consecutive_losses = max(consecutive_losses, current_losses)
        else:
            current_losses = 0
    return {
        "hours": hours,
        "trades": len(rows),
        "netPnlPct": round(cumulative, 6),
        "maxDrawdownPct": round(max_drawdown, 6),
        "consecutiveLosses": consecutive_losses,
    }


async def record_news_event(
    source: str,
    title: str,
    symbols: list[str],
    category: str,
    impact_score: float,
    risk_level: str,
    action: str,
    url: str = "",
    raw: dict | None = None,
    ttl_seconds: int = 7200,
) -> None:
    now = time.time()
    async with connect(DB_PATH) as db:
        await db.execute(
            """INSERT INTO news_events
               (source, title, url, symbols, category, impact_score, risk_level,
                action, raw, created_at, expires_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
            (
                source,
                title,
                url,
                json.dumps(symbols),
                category,
                impact_score,
                risk_level,
                action,
                json.dumps(raw or {}),
                now,
                now + ttl_seconds,
            ),
        )
        await db.commit()


async def get_active_news_context(symbol: str, now: float | None = None) -> dict:
    ts = now or time.time()
    async with connect(DB_PATH) as db:
        db.row_factory = Row
        rows = await (await db.execute(
            """SELECT * FROM news_events
               WHERE expires_at >= ?
               ORDER BY ABS(impact_score) DESC, created_at DESC
               LIMIT 100""",
            (ts,),
        )).fetchall()
    matched = []
    symbol_upper = symbol.upper()
    for r in rows:
        d = dict(r)
        symbols = json.loads(d["symbols"])
        if symbol_upper in symbols or "BTC-USDT" in symbols or "MARKET" in symbols:
            d["symbols"] = symbols
            d["raw"] = json.loads(d["raw"])
            matched.append(d)
    if not matched:
        return {
            "active": False,
            "newsImpactScore": 0.0,
            "riskLevel": "LOW",
            "action": "none",
            "events": [],
        }
    score = sum(float(x["impact_score"]) for x in matched[:5]) / min(5, len(matched))
    high_risk = any(str(x["risk_level"]).upper() == "HIGH" for x in matched)
    reduce = any(str(x["action"]).lower() in {"block", "reduce_aggression"} for x in matched)
    return {
        "active": True,
        "newsImpactScore": round(score, 4),
        "riskLevel": "HIGH" if high_risk else "MEDIUM" if abs(score) >= 0.35 else "LOW",
        "action": "block" if any(str(x["action"]).lower() == "block" for x in matched) else "reduce_aggression" if reduce else "context_only",
        "events": matched[:10],
    }


async def upsert_pattern(
    name: str, symbol: str, conditions: dict,
    won: bool, pnl_pct: float
):
    async with connect(DB_PATH) as db:
        row = await (await db.execute(
            "SELECT id, occurrences, wins, total_return FROM patterns WHERE name=? AND symbol=?",
            (name, symbol)
        )).fetchone()

        if row:
            pid, occ, wins, total_ret = row
            occ += 1
            wins += 1 if won else 0
            total_ret += pnl_pct
            avg_ret = total_ret / occ
            wr = wins / occ
            await db.execute(
                """UPDATE patterns SET occurrences=?, wins=?, total_return=?,
                   avg_return=?, win_rate=?, last_seen=?, conditions=?
                   WHERE id=?""",
                (occ, wins, total_ret, avg_ret, wr, time.time(),
                 json.dumps(conditions), pid)
            )
        else:
            wr = 1.0 if won else 0.0
            await db.execute(
                """INSERT INTO patterns
                   (name, symbol, conditions, occurrences, wins, total_return,
                    avg_return, win_rate, last_seen, created_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?)""",
                (name, symbol, json.dumps(conditions), 1,
                 1 if won else 0, pnl_pct, pnl_pct, wr,
                 time.time(), time.time())
            )
        await db.commit()


async def get_top_patterns(min_occurrences: int = 5, limit: int = 20) -> list[dict]:
    async with connect(DB_PATH) as db:
        db.row_factory = Row
        rows = await (await db.execute(
            """SELECT * FROM patterns
               WHERE occurrences >= ?
               ORDER BY win_rate DESC, avg_return DESC
               LIMIT ?""",
            (min_occurrences, limit)
        )).fetchall()
        return [dict(r) for r in rows]


async def get_symbol_stats(symbol: str, days: int = 30) -> dict:
    since = time.time() - days * 86400
    async with connect(DB_PATH) as db:
        db.row_factory = Row
        rows = await (await db.execute(
            """SELECT side, COUNT(*) as trades,
               SUM(win) as wins,
               AVG(pnl_pct) as avg_pnl,
               SUM(pnl_pct) as total_pnl,
               MIN(pnl_pct) as worst,
               MAX(pnl_pct) as best,
               AVG(pnl_usdt) as avg_pnl_usdt,
               SUM(pnl_usdt) as total_pnl_usdt
               FROM trade_outcomes
               WHERE symbol=? AND timestamp >= ?
               GROUP BY side""",
            (symbol, since)
        )).fetchall()
        result = {"symbol": symbol, "days": days, "sides": {}}
        for r in rows:
            d = dict(r)
            wr = d["wins"] / d["trades"] if d["trades"] else 0
            result["sides"][d["side"]] = {
                "trades": d["trades"],
                "win_rate": round(wr * 100, 1),
                "avg_pnl_pct": round(d["avg_pnl"] or 0, 4),
                "total_pnl_pct": round(d["total_pnl"] or 0, 4),
                "avg_pnl_usdt": round(d["avg_pnl_usdt"] or 0, 4),
                "total_pnl_usdt": round(d["total_pnl_usdt"] or 0, 4),
                "worst": round(d["worst"] or 0, 4),
                "best": round(d["best"] or 0, 4),
            }
        return result


async def get_all_symbols_stats(days: int = 30) -> list[dict]:
    symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "VVVUSDT", "TRUMPUSDT",
               "MELANIAUSDT", "BEATUSDT", "NEARUSDT", "HYPEUSDT", "POLUSDT"]
    return [await get_symbol_stats(s, days) for s in symbols]


async def save_observation(symbol: str, category: str, text: str, data: dict, confidence: float):
    async with connect(DB_PATH) as db:
        await db.execute(
            """INSERT INTO observations (symbol, category, text, data, confidence, timestamp)
               VALUES (?,?,?,?,?,?)""",
            (symbol, category, text, json.dumps(data), confidence, time.time())
        )
        await db.commit()


async def save_strategic_insight(
    period_days: int, analysis_text: str,
    edge_changes: dict, recommendations: list
):
    async with connect(DB_PATH) as db:
        await db.execute(
            """INSERT INTO strategic_insights
               (period_days, generated_at, analysis_text, edge_changes, recommendations)
               VALUES (?,?,?,?,?)""",
            (period_days, time.time(), analysis_text,
             json.dumps(edge_changes), json.dumps(recommendations))
        )
        await db.commit()


async def get_recent_insights(limit: int = 5) -> list[dict]:
    async with connect(DB_PATH) as db:
        db.row_factory = Row
        rows = await (await db.execute(
            "SELECT * FROM strategic_insights ORDER BY generated_at DESC LIMIT ?",
            (limit,)
        )).fetchall()
        result = []
        for r in rows:
            d = dict(r)
            d["edge_changes"] = json.loads(d["edge_changes"])
            d["recommendations"] = json.loads(d["recommendations"])
            result.append(d)
        return result


async def get_feature_history(symbol: str, hours: int = 24) -> list[dict]:
    """Return feature snapshot history compatible with signal_learning price lookups.

    Each returned dict is guaranteed to have ``price``, ``bid``, and ``ask`` fields
    so that ``_nearest_price`` and ``_executable_price`` work correctly even when
    the DB rows pre-date the bid/ask columns.
    """
    since = time.time() - hours * 3600
    async with connect(DB_PATH) as db:
        db.row_factory = Row
        rows = await (await db.execute(
            """SELECT * FROM feature_snapshots
               WHERE symbol=? AND timestamp >= ?
               ORDER BY timestamp ASC""",
            (symbol, since)
        )).fetchall()
        result = []
        for r in rows:
            d = dict(r)
            # Guarantee bid/ask presence for _executable_price fallback.
            # bid/ask columns were added via migration; older rows may be NULL.
            price = float(d.get("price") or 0)
            if not d.get("bid"):
                d["bid"] = price
            if not d.get("ask"):
                d["ask"] = price
            result.append(d)
        return result


async def get_recent_observations(symbol: str = None, hours: int = 48, limit: int = 50) -> list[dict]:
    since = time.time() - hours * 3600
    async with connect(DB_PATH) as db:
        db.row_factory = Row
        if symbol:
            rows = await (await db.execute(
                """SELECT * FROM observations
                   WHERE symbol=? AND timestamp >= ?
                   ORDER BY timestamp DESC LIMIT ?""",
                (symbol, since, limit)
            )).fetchall()
        else:
            rows = await (await db.execute(
                """SELECT * FROM observations
                   WHERE timestamp >= ?
                   ORDER BY timestamp DESC LIMIT ?""",
                (since, limit)
            )).fetchall()
        result = []
        for r in rows:
            d = dict(r)
            d["data"] = json.loads(d["data"])
            result.append(d)
        return result


# ========== NOVAS FUNÇÕES PARA NÍVEL MÁXIMO DE EXCELÊNCIA ==========

async def get_hour_toxicity(symbol: str, hour_utc: int, side: str) -> dict:
    """
    Retorna toxicidade por horário baseado em histórico real.
    Quanto maior toxicity_score, mais o horário é perigoso para operar.
    """
    async with connect(DB_PATH) as db:
        db.row_factory = Row
        row = await (await db.execute(
            """SELECT trades, win_rate, avg_pnl_pct, toxicity_score
               FROM hour_toxicity
               WHERE symbol=? AND hour_utc=? AND side=?
               ORDER BY updated_at DESC LIMIT 1""",
            (symbol, hour_utc, side)
        )).fetchone()

    if not row:
        return {"toxic": False, "toxicity_score": 0.0, "trades": 0, "win_rate": 0}

    d = dict(row)
    toxic = d["toxicity_score"] > 0.3
    return {
        "toxic": toxic,
        "toxicity_score": round(d["toxicity_score"], 3),
        "trades": d["trades"],
        "win_rate": round(d["win_rate"] * 100, 1) if d["win_rate"] else 0,
        "avg_pnl_pct": round(d["avg_pnl_pct"] or 0, 4),
    }


async def update_hour_toxicity(symbol: str, hour_utc: int, side: str, trades: list[dict]):
    """Atualiza score de toxicidade para um horário específico."""
    if len(trades) < 5:
        return

    wins = sum(1 for t in trades if t.get("pnl_pct", 0) > 0)
    total_pnl = sum(t.get("pnl_pct", 0) for t in trades)
    win_rate = wins / len(trades)
    avg_pnl = total_pnl / len(trades)

    # Fórmula de toxicidade: win_rate baixo + avg_pnl negativo = tóxico
    toxicity_score = max(0.0, (0.5 - win_rate) + max(0.0, -avg_pnl * 0.5))

    async with connect(DB_PATH) as db:
        await db.execute(
            """INSERT INTO hour_toxicity (symbol, hour_utc, side, trades, win_rate, avg_pnl_pct, toxicity_score, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(symbol, hour_utc, side) DO UPDATE SET
                   trades = excluded.trades,
                   win_rate = excluded.win_rate,
                   avg_pnl_pct = excluded.avg_pnl_pct,
                   toxicity_score = excluded.toxicity_score,
                   updated_at = excluded.updated_at""",
            (symbol, hour_utc, side, len(trades), win_rate, avg_pnl, toxicity_score, time.time())
        )
        await db.commit()


async def get_correlation(symbol_a: str, symbol_b: str, hours: int = 24) -> float:
    """Retorna correlação entre dois símbolos baseado em dados históricos."""
    correlation_key = f"{hours}h"

    async with connect(DB_PATH) as db:
        db.row_factory = Row
        row = await (await db.execute(
            """SELECT correlation_1h, correlation_4h, correlation_24h
               FROM symbol_correlations
               WHERE symbol_a=? AND symbol_b=?
               ORDER BY computed_at DESC LIMIT 1""",
            (symbol_a, symbol_b)
        )).fetchone()

    if not row:
        return 0.5  # Correlação padrão

    d = dict(row)
    if hours <= 1:
        return round(d.get("correlation_1h", 0.5), 3)
    elif hours <= 4:
        return round(d.get("correlation_4h", 0.5), 3)
    else:
        return round(d.get("correlation_24h", 0.5), 3)


async def record_execution_quality(
    symbol: str,
    side: str,
    expected_price: float,
    executed_price: float,
    latency_ms: float
):
    """Registra qualidade de execução para análise de slippage real."""
    slippage_bps = abs(executed_price - expected_price) / expected_price * 10000 if expected_price > 0 else 0

    async with connect(DB_PATH) as db:
        await db.execute(
            """INSERT INTO execution_quality
               (symbol, side, expected_price, executed_price, slippage_bps, latency_ms, timestamp)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (symbol, side, expected_price, executed_price, slippage_bps, latency_ms, time.time())
        )
        await db.commit()


async def get_avg_slippage_bps(symbol: str, hours: int = 24) -> float:
    """Retorna slippage médio real para o símbolo nas últimas N horas."""
    since = time.time() - hours * 3600

    async with connect(DB_PATH) as db:
        row = await (await db.execute(
            """SELECT AVG(slippage_bps) as avg_slippage
               FROM execution_quality
               WHERE symbol=? AND timestamp >= ?
               LIMIT 1000""",
            (symbol, since)
        )).fetchone()

    if not row or row[0] is None:
        return 2.0  # Default 2bps

    return round(float(row[0]), 2)


async def get_realized_sharpe(symbol: str, side: str, days: int = 30) -> float:
    """Calcula Sharpe Ratio realizado para o símbolo/lado."""
    since = time.time() - days * 86400

    async with connect(DB_PATH) as db:
        rows = await (await db.execute(
            """SELECT pnl_pct FROM trade_outcomes
               WHERE symbol=? AND side=? AND timestamp >= ?
               ORDER BY timestamp ASC""",
            (symbol, side, since)
        )).fetchall()

    returns = [float(r[0] or 0) for r in rows]
    if len(returns) < 10:
        return 0.0

    mean_return = sum(returns) / len(returns)
    variance = sum((r - mean_return) ** 2 for r in returns) / len(returns)
    std_return = variance ** 0.5 if variance > 0 else 0.0001

    if std_return == 0:
        return 0.0

    sharpe = (mean_return / std_return) * (365 ** 0.5)  # Anualizado
    return round(sharpe, 3)


async def get_rolling_win_rate(symbol: str, side: str, window_hours: int = 24) -> float:
    """Win rate em janela móvel para detecção de deterioração."""
    since = time.time() - window_hours * 3600

    async with connect(DB_PATH) as db:
        rows = await (await db.execute(
            """SELECT win FROM trade_outcomes
               WHERE symbol=? AND side=? AND timestamp >= ?
               ORDER BY timestamp DESC
               LIMIT 50""",
            (symbol, side, since)
        )).fetchall()

    if len(rows) < 10:
        return 0.5

    wins = sum(1 for r in rows if r[0] == 1)
    return round(wins / len(rows), 3)


async def vacuum_db():
    """Otimiza o banco de dados - agendado semanalmente."""
    async with connect(DB_PATH) as db:
        await db.execute("VACUUM")
        await db.execute("ANALYZE")


# ========== SIGNAL LIFECYCLE EVENTS ==========

async def record_lifecycle_event(
    event_type: str,
    symbol: str,
    side: str,
    signal_id: str | None = None,
    score: float | None = None,
    risk_profile: str | None = None,
    is_demo: bool = True,
    metadata: dict | None = None,
) -> None:
    """Record a signal lifecycle event for learning quality tracking."""
    async with connect(DB_PATH) as db:
        await db.execute(
            """INSERT INTO signal_lifecycle_events
               (signal_id, event_type, symbol, side, score, risk_profile, is_demo, metadata, ts)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (
                signal_id,
                event_type,
                symbol.upper(),
                side.upper(),
                score,
                risk_profile,
                1 if is_demo else 0,
                json.dumps(metadata or {}),
                time.time(),
            ),
        )
        await db.commit()


async def get_learning_metrics(hours: int = 24) -> dict:
    """
    Learning velocity and score-bucket metrics for monitoring QB evolution.
    Shows whether high-score trades outperform low-score trades, which is
    the primary signal that the Coach Ranker is improving.
    """
    since = time.time() - hours * 3600

    async with connect(DB_PATH) as db:
        db.row_factory = Row

        # 1. Event counts by type (last N hours)
        event_rows = await (await db.execute(
            """SELECT event_type, COUNT(*) as cnt
               FROM signal_lifecycle_events
               WHERE ts >= ? AND is_demo=1
               GROUP BY event_type ORDER BY cnt DESC""",
            (since,),
        )).fetchall()
        event_counts = {r["event_type"]: r["cnt"] for r in event_rows}

        # 2. Funnel: generated → executed → placed → tp/sl
        generated  = event_counts.get("signal_generated", 0)
        executed   = event_counts.get("signal_executed", 0)
        placed     = event_counts.get("order_placed", 0)
        tp_hits    = event_counts.get("tp_hit", 0)
        sl_hits    = event_counts.get("sl_hit", 0)
        timeouts   = event_counts.get("timeout", 0)
        api_errors = event_counts.get("api_error", 0)
        dupes      = event_counts.get("duplicate_rejected", 0)

        closed = tp_hits + sl_hits + timeouts
        win_rate = round(tp_hits / closed * 100, 1) if closed > 0 else None

        # 3. Score-bucket performance from signal_outcomes (finalized)
        # GROUP BY 1 (positional) is used instead of alias for Postgres compat.
        bucket_rows = await (await db.execute(
            """SELECT
                CASE
                    WHEN max_favorable_pct IS NULL THEN 'no_data'
                    WHEN target_configured_move_pct <= 0 THEN 'no_target'
                    ELSE 'has_outcome'
                END as bucket_type,
                COUNT(*) as cnt,
                AVG(CASE WHEN hit_configured=1 THEN 1.0 ELSE 0.0 END) as win_rate,
                AVG(max_favorable_pct) as avg_mfe,
                AVG(max_adverse_pct) as avg_mae,
                AVG(target_configured_move_pct) as avg_target
               FROM signal_outcomes
               WHERE created_at >= ? AND finalized=1
               GROUP BY 1""",
            (since,),
        )).fetchall()
        outcome_summary = [dict(r) for r in bucket_rows]

        # 4. Best performing symbols (by win rate, min 5 finalized)
        # HAVING COUNT(*) used instead of alias for Postgres compat.
        sym_rows = await (await db.execute(
            """SELECT symbol, side,
                COUNT(*) as trades,
                AVG(CASE WHEN hit_configured=1 THEN 1.0 ELSE 0.0 END) as win_rate,
                AVG(max_favorable_pct) as avg_mfe
               FROM signal_outcomes
               WHERE created_at >= ? AND finalized=1
               GROUP BY symbol, side
               HAVING COUNT(*) >= 5
               ORDER BY win_rate DESC
               LIMIT 10""",
            (since,),
        )).fetchall()
        top_symbols = [dict(r) for r in sym_rows]

        # 5. Samples by risk_profile
        profile_rows = await (await db.execute(
            """SELECT risk_profile, COUNT(*) as cnt
               FROM signal_lifecycle_events
               WHERE ts >= ? AND event_type='order_placed'
               GROUP BY risk_profile ORDER BY cnt DESC""",
            (since,),
        )).fetchall()
        profile_counts = {(r["risk_profile"] or "unknown"): r["cnt"] for r in profile_rows}

        # 6. Total finalized signals and pending
        totals = await (await db.execute(
            """SELECT
                SUM(CASE WHEN finalized=1 THEN 1 ELSE 0 END) as finalized,
                SUM(CASE WHEN finalized=0 THEN 1 ELSE 0 END) as pending
               FROM signal_outcomes WHERE created_at >= ?""",
            (since,),
        )).fetchone()

    return {
        "windowHours": hours,
        "funnel": {
            "generated": generated,
            "executed": executed,
            "placed": placed,
            "tpHits": tp_hits,
            "slHits": sl_hits,
            "timeouts": timeouts,
            "apiErrors": api_errors,
            "duplicateRejected": dupes,
            "closed": closed,
            "winRate": win_rate,
        },
        "eventCounts": event_counts,
        "outcomeSummary": outcome_summary,
        "topSymbols": top_symbols,
        "profileCounts": profile_counts,
        "signalTotals": {
            "finalized": int(totals["finalized"] or 0) if totals else 0,
            "pending": int(totals["pending"] or 0) if totals else 0,
        },
    }


# ─────────────────────────────────────────────────────────────────────────────
# Exit Intelligence — persistence helpers
# ─────────────────────────────────────────────────────────────────────────────

async def record_exit_outcome_row(
    *,
    source_id: str,
    symbol: str,
    side: str,
    is_demo: int = 1,
    entry_price: float = 0.0,
    exit_price: float = 0.0,
    pnl_pct: float,
    mfe_pct: float,
    mae_pct: float,
    gave_back_pct: float,
    age_seconds: float,
    tp_pct: float,
    sl_pct: float,
    exit_quality: str,
    exit_reason: str,
    exit_action_taken: str = "",
    entry_aggressive_score: float = 0.0,
    btc_regime: str = "NEUTRAL",
    hour_utc: int = 0,
    campaign_id: str = "",
    experiment_id: str = "",
    experiment_arm: str = "",
    policy_version: str = "",
) -> None:
    """Insert (or upsert) one exit outcome record."""
    ts = __import__("time").time()
    async with connect(DB_PATH) as db:
        await db.execute(
            """INSERT INTO exit_outcomes
               (source_id, symbol, side, is_demo, entry_price, exit_price,
                pnl_pct, mfe_pct, mae_pct, gave_back_pct, age_seconds,
                tp_pct, sl_pct, exit_quality, exit_reason, exit_action_taken,
                entry_aggressive_score, btc_regime, hour_utc, campaign_id,
                experiment_id, experiment_arm, policy_version, ts)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(source_id) DO UPDATE SET
                 exit_quality=excluded.exit_quality,
                 gave_back_pct=excluded.gave_back_pct,
                 mfe_pct=excluded.mfe_pct,
                 mae_pct=excluded.mae_pct,
                 pnl_pct=excluded.pnl_pct,
                 exit_action_taken=excluded.exit_action_taken,
                 experiment_id=excluded.experiment_id,
                 experiment_arm=excluded.experiment_arm,
                 policy_version=excluded.policy_version""",
            (source_id, symbol, side, is_demo, entry_price, exit_price,
             pnl_pct, mfe_pct, mae_pct, gave_back_pct, age_seconds,
             tp_pct, sl_pct, exit_quality, exit_reason, exit_action_taken,
             entry_aggressive_score, btc_regime, hour_utc, campaign_id,
             experiment_id, experiment_arm, policy_version, ts),
        )
        await db.commit()


async def record_exit_evaluation_row(
    *,
    source_id: str,
    symbol: str,
    side: str,
    action: str,
    confidence: float,
    reason: str,
    suggested_stop_pct: float,
    suggested_tp_pct: float,
    should_close: int,
    should_stack: int,
    protection_level: str,
    unrealized_pnl_pct: float,
    mfe_pct: float,
    age_seconds: float,
    momentum_score: float,
) -> None:
    """Insert one exit evaluation record (each QB recommendation stored)."""
    ts = __import__("time").time()
    async with connect(DB_PATH) as db:
        await db.execute(
            """INSERT INTO exit_evaluations
               (source_id, symbol, side, action, confidence, reason,
                suggested_stop_pct, suggested_tp_pct, should_close, should_stack,
                protection_level, unrealized_pnl_pct, mfe_pct, age_seconds,
                momentum_score, ts)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (source_id, symbol, side, action, confidence, reason,
             suggested_stop_pct, suggested_tp_pct, should_close, should_stack,
             protection_level, unrealized_pnl_pct, mfe_pct, age_seconds,
             momentum_score, ts),
        )
        await db.commit()


async def query_exit_stats(
    symbol: str | None = None,
    side: str | None = None,
    days: int = 30,
) -> dict:
    """
    Exit quality analytics — win-rate / PnL / MFE averages by quality label.
    Used by the /exit/stats endpoint and as a Coach Ranker learning signal.
    """
    since = __import__("time").time() - days * 86400
    filters: list[str] = ["ts >= ?"]
    params: list = [since]
    if symbol:
        filters.append("symbol = ?")
        params.append(symbol.upper())
    if side:
        filters.append("side = ?")
        params.append(side.upper())
    where = " AND ".join(filters)

    async with connect(DB_PATH) as db:
        # Quality breakdown
        quality_rows = await (await db.execute(
            f"""SELECT exit_quality,
                       COUNT(*) as cnt,
                       AVG(pnl_pct) as avg_pnl,
                       SUM(CASE WHEN pnl_pct > 0 THEN 1 ELSE 0 END) * 1.0 / COUNT(*) as win_rate,
                       AVG(mfe_pct) as avg_mfe,
                       AVG(mae_pct) as avg_mae,
                       AVG(gave_back_pct) as avg_gave_back
               FROM exit_outcomes
               WHERE {where}
               GROUP BY 1
               ORDER BY cnt DESC""",
            params,
        )).fetchall()

        # Action breakdown (what recommendations led to which outcomes)
        action_rows = await (await db.execute(
            f"""SELECT exit_action_taken,
                       COUNT(*) as cnt,
                       AVG(pnl_pct) as avg_pnl,
                       SUM(CASE WHEN pnl_pct > 0 THEN 1 ELSE 0 END) * 1.0 / COUNT(*) as win_rate,
                       AVG(gave_back_pct) as avg_gave_back
               FROM exit_outcomes
               WHERE {where} AND exit_action_taken != ''
               GROUP BY 1
               ORDER BY cnt DESC""",
            params,
        )).fetchall()

        # Symbol breakdown
        symbol_rows = await (await db.execute(
            f"""SELECT symbol,
                       COUNT(*) as cnt,
                       AVG(pnl_pct) as avg_pnl,
                       AVG(mfe_pct) as avg_mfe,
                       AVG(gave_back_pct) as avg_gave_back
               FROM exit_outcomes
               WHERE {where}
               GROUP BY 1
               ORDER BY cnt DESC
               LIMIT 20""",
            params,
        )).fetchall()

        # Overall summary
        summary = await (await db.execute(
            f"""SELECT COUNT(*) as total,
                       AVG(pnl_pct) as avg_pnl,
                       AVG(mfe_pct) as avg_mfe,
                       AVG(mae_pct) as avg_mae,
                       AVG(gave_back_pct) as avg_gave_back,
                       AVG(age_seconds) as avg_age_sec,
                       SUM(CASE WHEN pnl_pct > 0 THEN 1 ELSE 0 END) * 1.0 / COUNT(*) as win_rate
               FROM exit_outcomes
               WHERE {where}""",
            params,
        )).fetchone()

    def _fmt(row: dict) -> dict:
        return {k: (round(v, 4) if isinstance(v, float) else v) for k, v in dict(row).items()}

    return {
        "days": days,
        "symbol": symbol,
        "side": side,
        "summary": _fmt(summary) if summary else {},
        "byQuality": [_fmt(r) for r in quality_rows],
        "byAction": [_fmt(r) for r in action_rows],
        "bySymbol": [_fmt(r) for r in symbol_rows],
    }
