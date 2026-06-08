"""
API REST — expõe todos os dados do Quant Brain via HTTP.
Nível Máximo de Excelência: rate limiting, compression, caching,
request tracking, metrics, circuit breakers, graceful degradation.
Compatível com o dashboard existente e com consultas manuais.
"""
from __future__ import annotations

import asyncio
import time
import os
import logging
import uuid
import json
import gzip
from contextlib import asynccontextmanager
from collections import defaultdict
from datetime import datetime, timezone
from typing import Optional, Any
from functools import wraps

from fastapi import FastAPI, HTTPException, Query, BackgroundTasks, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

from core.feature_engine import FeatureEngine, SYMBOLS
from core import knowledge_base as kb
from core.database import close_pool, database_schema, using_postgres
from core.recommendation import recommend_entry, simulate_gate_rejections
from core.edge_gate import evaluate_edge_gate
from core.movement_sniper import evaluate_sniper_window, build_movement_features, classify_btc_commander
from core.signal_learning import finalize_due_signal_outcomes, score_signal_context
from core.shadow_model import restore_shadow_model, shadow_model_status, train_shadow_model
from core.shadow_sampler import shadow_sampler_status, sample_shadow_signals_once
from core.exit_intelligence import evaluate_exit
from core.exit_learning import record_exit_outcome as _record_exit_outcome, record_exit_evaluation, get_exit_stats
from core.experiment_engine import experiment_status, infer_assignment_for_outcome
from core.execution_auditor import record_trade_audit, get_execution_audit_report
from core.pipeline_auditor import validate_learning_eligibility
from core.position_sizing import calculate_position_size, build_status as build_position_sizing_status
from core.job_supervisor import JobSupervisor
from core.score_calibration import run_score_calibration
from core.candle_regime import analyze_macro_candle_regime, candle_regime_status
from core.regime_playbook import classify_regime_playbook
from api.kb_trades import record_trade as record_kb_trade
from layers.tactical import process_tactical_cycle, get_active_alerts, get_snapshot_history
from layers.strategic import build_strategic_report, report_to_dict, compute_edge_evolution
from analyst.ai_analyst import (
    run_weekly_analysis, run_tactical_analysis, run_hypothesis_generation, _has_ai
)

log = logging.getLogger("api")

engine = FeatureEngine()
_tasks: list[asyncio.Task] = []
_runtime_state = {
    "database_ready": False,
    "services_started": False,
    "startup_error": None,
    "started_at": time.time(),
}
_DB_INIT_TIMEOUT_SECONDS = float(os.environ.get("DB_INIT_TIMEOUT_SECONDS", "20"))
_DB_INIT_RETRY_SECONDS = float(os.environ.get("DB_INIT_RETRY_SECONDS", "10"))
_MODEL_MAINTENANCE_SECONDS = float(os.environ.get("MODEL_MAINTENANCE_SECONDS", "120"))
_TACTICAL_LOOP_SECONDS = max(5, int(float(os.environ.get("TACTICAL_LOOP_SECONDS", "15"))))
_JOB_MAX_CONCURRENCY = max(1, int(os.environ.get("JOB_MAX_CONCURRENCY", "2")))
_JOB_STALE_AFTER_SECONDS = max(30, int(float(os.environ.get("JOB_STALE_AFTER_SECONDS", "120"))))
_TACTICAL_JOB_TIMEOUT_SECONDS = max(5, int(float(os.environ.get("TACTICAL_JOB_TIMEOUT_SECONDS", "20"))))
_SHADOW_SAMPLER_JOB_TIMEOUT_SECONDS = max(5, int(float(os.environ.get("SHADOW_SAMPLER_JOB_TIMEOUT_SECONDS", "25"))))
_MODEL_JOB_TIMEOUT_SECONDS = max(10, int(float(os.environ.get("MODEL_JOB_TIMEOUT_SECONDS", "45"))))
_MACRO_CANDLE_ANALYSIS_SECONDS = max(60, int(float(os.environ.get("MACRO_CANDLE_ANALYSIS_SECONDS", "900"))))
_MACRO_CANDLE_JOB_TIMEOUT_SECONDS = max(10, int(float(os.environ.get("MACRO_CANDLE_JOB_TIMEOUT_SECONDS", "30"))))
job_supervisor = JobSupervisor(
    max_concurrent_jobs=_JOB_MAX_CONCURRENCY,
    stale_after_seconds=_JOB_STALE_AFTER_SECONDS,
)
_RETENTION_MAINTENANCE_SECONDS = float(
    os.environ.get("RETENTION_MAINTENANCE_SECONDS", "3600")
)
_last_model_training_attempt_samples = 0
_last_retention_maintenance_at = 0.0

# ========== NOVAS ESTRUTURAS PARA EXCELÊNCIA ==========

# Rate limiting
_rate_limit_cache: defaultdict = defaultdict(lambda: {"count": 0, "reset_at": 0})
_RATE_LIMIT_REQUESTS = int(os.environ.get("RATE_LIMIT_REQUESTS", 100))
_RATE_LIMIT_WINDOW = int(os.environ.get("RATE_LIMIT_WINDOW_SECONDS", 60))

# Request tracking
_request_counter = 0
_error_counter = 0
_endpoint_stats: defaultdict = defaultdict(lambda: {"calls": 0, "errors": 0, "total_time": 0})

# Cache simples
_response_cache: dict = {}
_CACHE_TTL_SECONDS = int(os.environ.get("CACHE_TTL_SECONDS", 30))
_CACHEABLE_ENDPOINTS = {"/market/snapshots", "/market/anomalies", "/health", "/"}


def _payload_source_id(payload: dict) -> str:
    for field in ("sourceId", "source_id", "id", "campaignId", "campaign_id", "signalId", "signal_id"):
        value = payload.get(field)
        if value is not None and str(value).strip():
            return str(value)
    return ""


async def _trade_outcome_exists(source_id: str) -> bool:
    if not source_id:
        return False
    async with kb.connect(kb.DB_PATH) as db:
        row = await (await db.execute(
            "SELECT 1 FROM trade_outcomes WHERE source_id=? LIMIT 1",
            (source_id,),
        )).fetchone()
    return row is not None


def _first_payload_value(payload: dict, *fields: str, default: Any = None) -> Any:
    for field in fields:
        value = payload.get(field)
        if value is not None:
            return value
    return default


def _float_or_none(value: Any) -> float | None:
    if value is None:
        return None
    return float(value)


def _str_or_none(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value)
    return text if text else None


def trade_payload_to_record_args(payload: dict, experiment: dict | None = None) -> dict:
    """Map a /kb/trades payload to record_trade_outcome kwargs."""
    experiment = experiment or {}
    side = _first_payload_value(payload, "positionSide", "position_side", "side")
    pnl_pct = payload.get("pnl_pct", payload.get("pnlPct"))
    if pnl_pct is None:
        realized_pnl = float(_first_payload_value(payload, "realizedPnl", "realized_pnl", default=0))
        margin_used = float(_first_payload_value(payload, "marginUsed", "margin_used", default=0))
        pnl_pct = (realized_pnl / margin_used * 100) if margin_used > 0 else realized_pnl

    pnl_usdt = _first_payload_value(payload, "pnl_usdt", "realizedPnl", "realized_pnl", default=0)
    policy_version = _first_payload_value(payload, "policyVersion", "policy_version")

    return {
        "source_id": _payload_source_id(payload) or None,
        "source": str(payload.get("source") or "manual"),
        "is_demo": bool(_first_payload_value(payload, "isDemo", "is_demo", default=False)),
        "symbol": payload["symbol"],
        "side": side,
        "pnl_pct": float(pnl_pct),
        "pnl_usdt": float(pnl_usdt) if pnl_usdt else 0.0,
        "entry_price": float(_first_payload_value(payload, "entry_price", "entryPrice", default=0)),
        "exit_price": float(_first_payload_value(payload, "exit_price", "exitPrice", default=0)),
        "oi_change": float(_first_payload_value(payload, "oi_change", "oiChange", default=0)),
        "funding": float(_first_payload_value(payload, "funding", "fundingRate", default=0)),
        "volume_ratio": float(_first_payload_value(payload, "volume_ratio", "volumeRatio", default=1)),
        "btc_regime": _first_payload_value(payload, "btc_regime", "btcRegime", "regime", default="NEUTRAL"),
        "rsi": float(_first_payload_value(payload, "rsi", "rsiAtEntry", default=50)),
        "ema_cross": _first_payload_value(payload, "ema_cross", "emaCross", default="FLAT"),
        "slippage_bps": float(_first_payload_value(payload, "slippage_bps", "slippageBps", default=0)),
        "fee_paid_usdt": float(_first_payload_value(payload, "fee_paid_usdt", "feePaidUsdt", default=0)),
        "experiment_id": _str_or_none(experiment.get("experimentId") or _first_payload_value(payload, "experimentId", "experiment_id")),
        "experiment_arm": _str_or_none(experiment.get("experimentArm") or _first_payload_value(payload, "experimentArm", "experiment_arm")),
        "policy_version": _str_or_none(policy_version),
        "campaign_id": _str_or_none(_first_payload_value(payload, "campaignId", "campaign_id")),
        "mfe_pct": _float_or_none(_first_payload_value(payload, "mfePct", "mfe_pct", "mfe")),
        "mae_pct": _float_or_none(_first_payload_value(payload, "maePct", "mae_pct", "mae")),
        "exit_reason": _str_or_none(_first_payload_value(payload, "exitReason", "exit_reason")),
        "latency_drag_usdt": _float_or_none(_first_payload_value(payload, "latencyDragUsdt", "latency_drag_usdt")),
        "regime": _first_payload_value(payload, "regime"),
        "playbook": _first_payload_value(payload, "playbook"),
        "setup_type": _first_payload_value(payload, "setupType", "setup_type", "setup"),
        "regime_confidence": _float_or_none(_first_payload_value(payload, "regimeConfidence", "regime_confidence")),
        "playbook_version": _str_or_none(_first_payload_value(payload, "playbookVersion", "playbook_version")),
        "stacking_depth": int(_first_payload_value(payload, "stackingDepth", "stacking_depth", default=1)),
        "execution_priority": _float_or_none(_first_payload_value(payload, "executionPriority", "execution_priority", "score")),
        "coach_score": _float_or_none(_first_payload_value(payload, "coachScore", "coach_score", "executionPriority", "score")),
        "playbook_score": _float_or_none(_first_payload_value(payload, "playbookScore", "playbook_score")),
        "ml_probability": _float_or_none(_first_payload_value(payload, "mlProbability", "calibratedProbability", "calibrated_probability")),
        "execution_quality": _float_or_none(_first_payload_value(payload, "executionQuality", "execution_quality")),
        "signal_id": _str_or_none(_first_payload_value(payload, "signalId", "signal_id")) or "",
        "entry_aggressive_score": _float_or_none(_first_payload_value(payload, "aggressiveScore", "entryAggressiveScore", "entry_aggressive_score")),
        "risk_tier": _first_payload_value(payload, "risk_tier", "riskTier"),
        "size_multiplier": _float_or_none(_first_payload_value(payload, "sizeMultiplier", "size_multiplier")),
        "size_reason": _first_payload_value(payload, "size_reason", "sizeReason"),
        "recommended_margin": _float_or_none(_first_payload_value(payload, "recommendedMargin", "recommended_margin")),
        "recommended_leverage": _float_or_none(_first_payload_value(payload, "recommendedLeverage", "recommended_leverage")),
        "max_loss_if_stop": _float_or_none(_first_payload_value(payload, "maxLossIfStop", "max_loss_if_stop")),
        "notional": _float_or_none(_first_payload_value(payload, "notional")),
        "strategy_version": _str_or_none(_first_payload_value(payload, "strategyVersion", "strategy_version")),
        "config_version": _str_or_none(_first_payload_value(payload, "configVersion", "config_version")),
        "model_version": _str_or_none(_first_payload_value(payload, "modelVersion", "model_version")),
        "label_version": _str_or_none(_first_payload_value(payload, "labelVersion", "label_version")),
        "market_event_id": _str_or_none(_first_payload_value(payload, "marketEventId", "market_event_id")),
        "source_type": _str_or_none(_first_payload_value(payload, "sourceType", "source_type")),
        "sizing": _first_payload_value(payload, "sizing"),
    }


def _is_liveness_path(request: Request) -> bool:
    return request.url.path == "/health/live"


class RateLimitMiddleware(BaseHTTPMiddleware):
    """Middleware de rate limiting por IP."""

    async def dispatch(self, request: Request, call_next):
        if _is_liveness_path(request):
            return await call_next(request)

        client_ip = request.client.host if request.client else "unknown"
        now = time.time()

        cache_key = f"{client_ip}:{request.url.path}"
        stats = _rate_limit_cache[cache_key]

        if stats["reset_at"] < now:
            stats["count"] = 0
            stats["reset_at"] = now + _RATE_LIMIT_WINDOW

        stats["count"] += 1

        if stats["count"] > _RATE_LIMIT_REQUESTS:
            return JSONResponse(
                status_code=429,
                content={
                    "error": "Rate limit exceeded",
                    "limit": _RATE_LIMIT_REQUESTS,
                    "window_seconds": _RATE_LIMIT_WINDOW,
                    "retry_after": int(stats["reset_at"] - now)
                }
            )

        response = await call_next(request)
        response.headers["X-RateLimit-Limit"] = str(_RATE_LIMIT_REQUESTS)
        response.headers["X-RateLimit-Remaining"] = str(max(0, _RATE_LIMIT_REQUESTS - stats["count"]))
        response.headers["X-RateLimit-Reset"] = str(int(stats["reset_at"]))

        return response


class RequestIDMiddleware(BaseHTTPMiddleware):
    """Middleware para tracking de requests com ID único."""

    async def dispatch(self, request: Request, call_next):
        if _is_liveness_path(request):
            return await call_next(request)

        request_id = request.headers.get("X-Request-ID", str(uuid.uuid4())[:8])
        request.state.request_id = request_id
        request.state.start_time = time.time()

        response = await call_next(request)
        response.headers["X-Request-ID"] = request_id

        elapsed = time.time() - request.state.start_time
        response.headers["X-Response-Time-MS"] = str(int(elapsed * 1000))

        return response


class MetricsMiddleware(BaseHTTPMiddleware):
    """Middleware para coleta de métricas de API."""

    async def dispatch(self, request: Request, call_next):
        global _request_counter, _error_counter

        if _is_liveness_path(request):
            return await call_next(request)

        path = request.url.path
        method = request.method

        _request_counter += 1
        _endpoint_stats[f"{method}:{path}"]["calls"] += 1

        start = time.time()

        try:
            response = await call_next(request)
            elapsed = time.time() - start
            _endpoint_stats[f"{method}:{path}"]["total_time"] += elapsed

            if response.status_code >= 400:
                _error_counter += 1
                _endpoint_stats[f"{method}:{path}"]["errors"] += 1

            return response
        except Exception as e:
            _error_counter += 1
            _endpoint_stats[f"{method}:{path}"]["errors"] += 1
            raise


def cache_response(ttl_seconds: int = None):
    """Decorator para cache de respostas."""
    def decorator(func):
        @wraps(func)
        async def wrapper(*args, **kwargs):
            if not os.environ.get("ENABLE_API_CACHE", "true").lower() == "true":
                return await func(*args, **kwargs)

            cache_ttl = ttl_seconds or _CACHE_TTL_SECONDS
            cache_key = f"{func.__name__}:{str(args)}:{str(sorted(kwargs.items()))}"

            if cache_key in _response_cache:
                cached, cached_at = _response_cache[cache_key]
                if time.time() - cached_at < cache_ttl:
                    return cached

            result = await func(*args, **kwargs)
            _response_cache[cache_key] = (result, time.time())

            # Limpa cache antigo a cada 100 chamadas
            if len(_response_cache) > 200:
                now = time.time()
                to_delete = [k for k, (_, ts) in _response_cache.items() if now - ts > 300]
                for k in to_delete:
                    del _response_cache[k]

            return result
        return wrapper
    return decorator


# ========== LIFESPAN ==========

async def _run_model_maintenance_once():
    global _last_model_training_attempt_samples, _last_retention_maintenance_at

    await finalize_due_signal_outcomes()
    await restore_shadow_model()
    summary = await kb.get_signal_training_summary(decision_group=None, source_type=None)
    status = shadow_model_status()
    trained_samples = int(status.get("samples", 0) or 0)
    samples = int(summary["samples"])
    needs_initial_train = not status.get("available") and samples >= 300
    needs_refresh = status.get("available") and samples >= trained_samples + 100
    unseen_attempt = samples > _last_model_training_attempt_samples

    if (
        (needs_initial_train or needs_refresh)
        and summary["hasBothClasses"]
        and unseen_attempt
    ):
        _last_model_training_attempt_samples = samples
        result = await train_shadow_model(min_samples=300)
        log.info(
            "Shadow model training completed: trained=%s samples=%s reason=%s",
            result.get("trained"),
            samples,
            result.get("reason"),
        )
    if time.time() - _last_retention_maintenance_at >= _RETENTION_MAINTENANCE_SECONDS:
        deleted = await kb.cleanup_retention()
        _last_retention_maintenance_at = time.time()
        if any(deleted.values()):
            log.info("Retention cleanup completed: %s", deleted)


async def _run_model_maintenance_loop():
    while True:
        try:
            await _run_model_maintenance_once()
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("Signal/model maintenance failed")

        await asyncio.sleep(_MODEL_MAINTENANCE_SECONDS)
        
async def _initialize_runtime_services():
    """Initialize persistent state without blocking HTTP health probes."""
    # 🔥 MUDA AQUI: Tenta apenas UMA vez, sem loop infinito
    try:
        await asyncio.wait_for(kb.init_db(), timeout=_DB_INIT_TIMEOUT_SECONDS)
        
        # FALLBACK - VALOR PADRÃO ENQUANTO NÃO TEM DADOS
        _runtime_state["operational_risk"] = {
            "hours": 1,
            "trades": 0,
            "netPnlPct": 0.0,
            "maxDrawdownPct": 0.0,
            "consecutiveLosses": 0,
        }
        log.info("Operational risk metrics: using default values (no trades yet)")
        
        _runtime_state["database_ready"] = True
        _runtime_state["startup_error"] = None
        log.info("Knowledge Base initialized")
        
    except asyncio.TimeoutError:
        _runtime_state["database_ready"] = False
        _runtime_state["startup_error"] = "KB init timeout"
        log.error(f"Knowledge Base initialization TIMEOUT after {_DB_INIT_TIMEOUT_SECONDS}s - continuing anyway")
        
    except Exception as exc:
        _runtime_state["database_ready"] = False
        _runtime_state["startup_error"] = f"{type(exc).__name__}: {exc}"
        log.exception("Knowledge Base initialization failed - continuing anyway")

    # Runtime jobs are supervised with bounded concurrency, timeouts, and
    # heartbeat metrics. This keeps HTTP liveness independent from heavy loops.
    job_supervisor.register(
        "tactical_market_cycle",
        lambda: process_tactical_cycle(engine),
        interval_seconds=_TACTICAL_LOOP_SECONDS,
        timeout_seconds=_TACTICAL_JOB_TIMEOUT_SECONDS,
        priority="market",
    )

    from layers.strategic import run_strategic_loop
    strategic_task = asyncio.create_task(run_strategic_loop(interval_hours=6))
    _tasks.append(strategic_task)
    log.info("Strategic loop started (6h interval)")

    job_supervisor.register(
        "model_maintenance",
        _run_model_maintenance_once,
        interval_seconds=_MODEL_MAINTENANCE_SECONDS,
        timeout_seconds=_MODEL_JOB_TIMEOUT_SECONDS,
        priority="low",
    )
    log.info(f"Signal finalizer/model maintenance registered ({_MODEL_MAINTENANCE_SECONDS:.1f}s interval)")

    job_supervisor.register(
        "macro_candle_regime",
        lambda: analyze_macro_candle_regime(engine, SYMBOLS),
        interval_seconds=_MACRO_CANDLE_ANALYSIS_SECONDS,
        timeout_seconds=_MACRO_CANDLE_JOB_TIMEOUT_SECONDS,
        priority="low",
        run_immediately=False,
    )

    sampler_interval = max(15, int(float(os.environ.get("SHADOW_SAMPLER_INTERVAL_SECONDS", "60"))))
    job_supervisor.register(
        "shadow_signal_sampler",
        lambda: sample_shadow_signals_once(engine),
        interval_seconds=sampler_interval,
        timeout_seconds=max(30, int(float(os.environ.get("SHADOW_SAMPLER_JOB_TIMEOUT_SECONDS", "60")))),
        priority="normal",
        enabled=os.environ.get("SHADOW_SAMPLER_ENABLED", "true").strip().lower() not in {"0", "false", "no", "off"},
        run_immediately=True,
    )
    job_supervisor.start()
    log.info(f"Runtime job supervisor started with {len(job_supervisor.jobs)} jobs")


    _runtime_state["services_started"] = True
    return

@asynccontextmanager
async def lifespan(app: FastAPI):
    start_time = time.time()
    log.info("=" * 60)
    log.info("🐂 QUANT BRAIN API - Inicializando")
    log.info("=" * 60)

    _runtime_state["database_ready"] = False
    _runtime_state["services_started"] = False
    _runtime_state["startup_error"] = None
    _runtime_state["started_at"] = start_time

    # 🔥 MUDA AQUI: NÃO aguarda a inicialização dos serviços
    bootstrap_task = asyncio.create_task(_initialize_runtime_services())
    _tasks.append(bootstrap_task)

    # Tarefa de limpeza de cache
    async def cache_cleaner():
        while True:
            await asyncio.sleep(60)
            now = time.time()
            to_delete = [k for k, (_, ts) in _response_cache.items() if now - ts > 300]
            for k in to_delete:
                del _response_cache[k]
            if to_delete:
                log.debug(f"Cache cleaned: {len(to_delete)} entries removed")

    t3 = asyncio.create_task(cache_cleaner())
    _tasks.append(t3)

    elapsed = time.time() - start_time
    log.info(f"✅ Quant Brain HTTP online em {elapsed:.2f}s; runtime initializing")
    log.info(f"📡 API disponível em http://localhost:{os.environ.get('PORT', 9000)}")
    log.info(f"🤖 AI Analyst: {'✅ habilitado' if _has_ai() else '❌ desabilitado'}")

    yield

    log.info("🛑 Encerrando Quant Brain...")
    await job_supervisor.stop()
    for t in _tasks:
        t.cancel()
        try:
            await t
        except asyncio.CancelledError:
            pass
    await engine.close()
    await close_pool()
    log.info("✅ Quant Brain encerrado com sucesso")
# ========== APP ==========

app = FastAPI(
    title="Quant Brain API",
    description="Motor de análise quantitativa e IA para o bot BingX. Nível máximo de excelência.",
    version="2.0.0",
    lifespan=lifespan,
    docs_url="/docs",
    redoc_url="/redoc",
)

# Middlewares (ordem importa)
app.add_middleware(GZipMiddleware, minimum_size=1000)
app.add_middleware(RequestIDMiddleware)
app.add_middleware(RateLimitMiddleware)
app.add_middleware(MetricsMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        origin.strip()
        for origin in os.environ.get("FRONTEND_URLS", "").split(",")
        if origin.strip()
    ] or ["*"],
    allow_credentials=bool(os.environ.get("FRONTEND_URLS", "").strip()),
    allow_methods=["*"],
    allow_headers=["*"],
)


# ========== MIDDLEWARE DE AUTENTICAÇÃO ==========

@app.middleware("http")
async def authenticate_internal_api(request: Request, call_next):
    token = os.environ.get("QUANT_BRAIN_API_TOKEN", "").strip()
    if token and request.method not in {"GET", "HEAD", "OPTIONS"}:
        supplied = request.headers.get("X-Quant-Brain-Token", "")
        authorization = request.headers.get("Authorization", "")
        if authorization.startswith("Bearer "):
            supplied = authorization[7:]
        if supplied != token:
            return JSONResponse(
                {"detail": "Unauthorized", "request_id": getattr(request.state, "request_id", None)},
                status_code=401
            )
    return await call_next(request)


# ========== ENDPOINTS DE MÉTRICAS E STATUS ==========

@app.get("/metrics")
async def get_metrics():
    """Endpoint de métricas para monitoramento (Prometheus compatible)."""
    global _request_counter, _error_counter

    metrics = {
        "total_requests": _request_counter,
        "total_errors": _error_counter,
        "error_rate": round(_error_counter / max(1, _request_counter) * 100, 2),
        "endpoints": {},
        "rate_limit_config": {
            "requests_per_window": _RATE_LIMIT_REQUESTS,
            "window_seconds": _RATE_LIMIT_WINDOW,
        },
        "cache": {
            "size": len(_response_cache),
            "ttl_seconds": _CACHE_TTL_SECONDS,
        },
        "jobs": job_supervisor.status(),
    }

    for endpoint, stats in _endpoint_stats.items():
        metrics["endpoints"][endpoint] = {
            "calls": stats["calls"],
            "errors": stats["errors"],
            "avg_time_ms": round(stats["total_time"] / max(1, stats["calls"]) * 1000, 2),
        }

    return metrics


@app.get("/experiments/status")
async def get_experiments_status(days: int = Query(30, ge=1, le=365)):
    """A/B experiment status: active arms, samples, PnL, PF, drawdown and recommendation."""
    return await experiment_status(days=days)


@app.get("/health/live")
async def liveness_check():
    """Liveness probe para Kubernetes/Railway."""
    return {
        "status": "alive",
        "runtime_ready": _runtime_state["services_started"],
        "job_supervisor": {
            "staleJobs": job_supervisor.status()["staleJobs"],
            "maxConcurrentJobs": job_supervisor.status()["maxConcurrentJobs"],
        },
        "timestamp": time.time(),
    }


@app.get("/health/ready")
async def readiness_check():
    """Readiness probe - verifica se o sistema está pronto para operar."""
    snaps = engine.get_all_snapshots()
    db_ok = bool(_runtime_state["database_ready"])
    jobs = job_supervisor.status()
    ready = bool(_runtime_state["services_started"]) and len(snaps) > 0 and not jobs["staleJobs"]

    return {
        "ready": ready,
        "snapshots_cached": len(snaps),
        "database_ok": db_ok,
        "services_started": _runtime_state["services_started"],
        "startup_error": _runtime_state["startup_error"],
        "jobs": jobs,
        "ai_enabled": _has_ai(),
        "timestamp": time.time()
    }


# ========== MARKET DATA ==========

@app.get("/market/snapshots")
@cache_response(ttl_seconds=5)
async def get_snapshots():
    """Estado atual de todos os 10 ativos."""
    snaps = engine.get_all_snapshots()
    return {
        "timestamp": time.time(),
        "count": len(snaps),
        "symbols": {
            sym: engine.to_dict(snap)
            for sym, snap in snaps.items()
        }
    }


@app.get("/market/snapshots/{symbol}")
async def get_snapshot(symbol: str):
    """Estado atual de um ativo específico."""
    sym = symbol.upper()
    if not sym.endswith("-USDT"):
        sym = sym + "-USDT"
    snap = engine.get_snapshot(sym)
    if not snap:
        raise HTTPException(404, f"Símbolo {sym} não encontrado ou ainda sem dados")
    return engine.to_dict(snap)


@app.get("/market/anomalies")
@cache_response(ttl_seconds=5)
async def get_anomalies():
    """Todos os ativos com anomalias detectadas agora."""
    snaps = engine.get_all_snapshots()
    result = []
    for sym, snap in snaps.items():
        if snap.anomalies:
            result.append({
                "symbol": sym,
                "anomalies": snap.anomalies,
                "price": snap.price,
                "price_change_pct": snap.price_change_pct,
                "oi_change_pct": snap.oi_change_pct,
                "volume_ratio": snap.volume_ratio,
                "funding_rate": snap.funding_rate,
                "rsi": snap.rsi_approx,
                "btc_regime": snap.btc_regime,
                "timestamp": snap.timestamp,
            })
    result.sort(key=lambda x: len(x["anomalies"]), reverse=True)
    return {"timestamp": time.time(), "count": len(result), "anomalies": result}


@app.get("/market/macro-regime")
@cache_response(ttl_seconds=15)
async def get_macro_candle_regime():
    """15m heavy candle regime: 1h/4h/1d bias and correction risk."""
    return candle_regime_status()


# ========== SNIPER ==========

@app.get("/sniper/btc-commander")
@cache_response(ttl_seconds=2)
async def get_btc_commander(window_seconds: int = Query(300, ge=60, le=900)):
    """BTC real-time commander for sniper scalp gating."""
    history = get_snapshot_history("BTC-USDT", window_seconds)
    features = build_movement_features("BTC-USDT", history, window_seconds)
    return {
        "timestamp": time.time(),
        "windowSeconds": window_seconds,
        "commander": classify_btc_commander(features),
        "features": features.__dict__,
    }


@app.get("/sniper/evaluate/{symbol}")
@cache_response(ttl_seconds=2)
async def evaluate_sniper_symbol(symbol: str, window_seconds: int = Query(300, ge=60, le=900)):
    """Evaluate a symbol against BTC movement for short-target sniper entries."""
    sym = symbol.upper()
    if not sym.endswith("-USDT"):
        sym = f"{sym}-USDT"
    alt_history = get_snapshot_history(sym, window_seconds)
    btc_history = get_snapshot_history("BTC-USDT", window_seconds)
    return evaluate_sniper_window(sym, alt_history, btc_history, window_seconds=window_seconds)


# ========== TACTICAL ==========

@app.get("/tactical/alerts")
@cache_response(ttl_seconds=10)
async def get_tactical_alerts(max_age: int = Query(300, description="Segundos")):
    """Alertas táticos recentes (padrões detectados em tempo real)."""
    alerts = get_active_alerts(max_age)
    return {
        "timestamp": time.time(),
        "count": len(alerts),
        "alerts": [
            {
                "symbol": a.symbol,
                "alert_type": a.alert_type,
                "message": a.message,
                "confidence": a.confidence,
                "similar_occurrences": a.similar_occurrences,
                "avg_return_past": a.avg_return_past,
                "win_rate_past": a.win_rate_past,
                "conditions": a.conditions,
                "timestamp": a.timestamp,
            }
            for a in alerts
        ]
    }


@app.post("/tactical/analyze")
async def run_tactical_ai(background_tasks: BackgroundTasks):
    """Dispara análise tática com IA agora (usa Claude se configurado)."""
    alerts = [
        {
            "symbol": a.symbol,
            "alert_type": a.alert_type,
            "confidence": a.confidence,
            "similar_occurrences": a.similar_occurrences,
            "win_rate_past": a.win_rate_past,
            "avg_return_past": a.avg_return_past,
        }
        for a in get_active_alerts(600)
    ]
    snaps = {sym: engine.to_dict(snap) for sym, snap in engine.get_all_snapshots().items()}
    observations = await kb.get_recent_observations(hours=2, limit=20)
    analysis = await run_tactical_analysis(alerts, snaps, observations)
    return {
        "analysis_type": analysis.analysis_type,
        "generated_at": analysis.generated_at,
        "model": analysis.model,
        "ai_enabled": _has_ai(),
        "full_text": analysis.full_text,
        "summary": analysis.summary,
    }


# ========== STRATEGIC ==========

@app.get("/strategic/report")
@cache_response(ttl_seconds=60)
async def get_strategic_report(days: int = Query(30, ge=1, le=365)):
    """Relatório estratégico: evolução de edge, rankings, mudanças estruturais."""
    report = await build_strategic_report(days)
    return report_to_dict(report)


@app.get("/strategic/edge-evolution")
@cache_response(ttl_seconds=60)
async def get_edge_evolution(days: int = Query(30, ge=7, le=365)):
    """Evolução de edge por símbolo e lado (primeira vs segunda metade do período)."""
    evolutions = await compute_edge_evolution(days)
    return {
        "period_days": days,
        "generated_at": time.time(),
        "count": len(evolutions),
        "evolutions": [
            {
                "symbol": e.symbol,
                "side": e.side,
                "wr_early": e.win_rate_early,
                "wr_late": e.win_rate_late,
                "delta_wr": e.delta_wr,
                "avg_pnl_early": e.avg_pnl_early,
                "avg_pnl_late": e.avg_pnl_late,
                "trend": e.trend,
                "trades_early": e.trades_early,
                "trades_late": e.trades_late,
            }
            for e in evolutions
        ]
    }


@app.post("/strategic/analyze")
async def run_strategic_ai(days: int = Query(30, ge=7, le=365)):
    """Dispara análise estratégica com IA (relatório semanal / Head of Quant)."""
    report = await build_strategic_report(days)
    evolutions_dicts = [
        {
            "symbol": e.symbol, "side": e.side,
            "wr_early": e.win_rate_early, "wr_late": e.win_rate_late,
            "delta_wr": e.delta_wr, "trend": e.trend,
        }
        for e in report.edge_migrations
    ]
    patterns = await kb.get_top_patterns(min_occurrences=3, limit=20)
    all_stats = await kb.get_all_symbols_stats(days)

    analysis = await run_weekly_analysis(all_stats, evolutions_dicts, patterns)
    await kb.save_strategic_insight(
        period_days=days,
        analysis_text=analysis.full_text,
        edge_changes={e.symbol + "_" + e.side: {"trend": e.trend, "delta_wr": e.delta_wr} for e in report.edge_migrations},
        recommendations=report.structural_changes,
    )

    return {
        "analysis_type": analysis.analysis_type,
        "generated_at": analysis.generated_at,
        "model": analysis.model,
        "ai_enabled": _has_ai(),
        "full_text": analysis.full_text,
        "report_summary": {
            "total_trades": report.total_trades,
            "global_win_rate": report.global_win_rate,
            "structural_changes": report.structural_changes,
        }
    }


@app.post("/strategic/hypotheses")
async def generate_hypotheses():
    """Gera hipóteses originais de edge com base nos padrões acumulados."""
    patterns = await kb.get_top_patterns(min_occurrences=2, limit=20)
    observations = await kb.get_recent_observations(hours=48, limit=30)
    stats = await kb.get_all_symbols_stats(30)
    analysis = await run_hypothesis_generation(patterns, observations, stats)
    return {
        "generated_at": analysis.generated_at,
        "model": analysis.model,
        "ai_enabled": _has_ai(),
        "hypotheses": analysis.full_text,
    }


# ========== KNOWLEDGE BASE ==========

@app.get("/kb/patterns")
@cache_response(ttl_seconds=30)
async def get_patterns(min_occurrences: int = Query(1, ge=1), limit: int = Query(50, le=200)):
    """Padrões acumulados na Knowledge Base, ordenados por win rate."""
    patterns = await kb.get_top_patterns(min_occurrences, limit)
    return {"count": len(patterns), "patterns": patterns}


@app.get("/kb/observations")
@cache_response(ttl_seconds=15)
async def get_observations(
    symbol: str = Query(None),
    hours: int = Query(48, ge=1, le=720),
    limit: int = Query(50, le=200),
):
    """Observações táticas e lead-lag recentes."""
    obs = await kb.get_recent_observations(symbol, hours, limit)
    return {"count": len(obs), "observations": obs}


@app.get("/kb/insights")
@cache_response(ttl_seconds=60)
async def get_insights(limit: int = Query(5, le=20)):
    """Últimos relatórios estratégicos salvos."""
    insights = await kb.get_recent_insights(limit)
    return {"count": len(insights), "insights": insights}


@app.get("/kb/stats/{symbol}")
@cache_response(ttl_seconds=30)
async def get_symbol_stats(symbol: str, days: int = Query(30, ge=1, le=365)):
    """Estatísticas de trades por símbolo."""
    stats = await kb.get_symbol_stats(symbol.upper(), days)
    return stats


@app.get("/kb/stats")
@cache_response(ttl_seconds=30)
async def get_all_stats(days: int = Query(30, ge=1, le=365)):
    """Estatísticas de todos os símbolos."""
    stats = await kb.get_all_symbols_stats(days)
    return {"period_days": days, "symbols": stats}


@app.post("/kb/trades")
async def record_trade(body: dict):
    """Registra resultado de um trade na KB (chamado pelo bot Node.js)."""
    result = await record_kb_trade(body)
    _response_cache.clear()
    return result
    required = ["symbol"]
    for r in required:
        if r not in body:
            raise HTTPException(400, f"Campo obrigatório: {r}")
    source_id = _payload_source_id(body)
    if not source_id:
        raise HTTPException(400, "Required field: sourceId")
    eligibility = validate_learning_eligibility(body)
    if not eligibility.learning_eligible:
        raise HTTPException(
            422,
            {
                "error": "pipeline_integrity_blocked",
                "blockedReasons": eligibility.blocked_reasons,
            },
        )
    side = body.get("positionSide") or body.get("position_side") or body.get("side")
    if not side:
        raise HTTPException(400, "Required field: side or positionSide")
    experiment = await infer_assignment_for_outcome(body) or {}

    duplicate = await _trade_outcome_exists(source_id)

    record_args = trade_payload_to_record_args(body, experiment)
    recorded = await kb.record_trade_outcome(**record_args)
    execution_audit = await record_trade_audit(body)

    # Invalida cache relacionado
    _response_cache.clear()

    return {
        "ok": True,
        "sourceId": source_id,
        "recorded": bool(recorded or duplicate),
        "duplicate": duplicate,
        "symbol": body["symbol"],
        "pnl_pct": float(record_args["pnl_pct"]),
        "experiment": experiment,
        "executionAudit": execution_audit,
    }


@app.post("/execution/audit/trade")
async def record_execution_audit_trade(body: dict):
    """Audit one closed trade execution payload without recording a KB trade outcome."""
    if "symbol" not in body:
        raise HTTPException(400, "Required field: symbol")
    return await record_trade_audit(body)


@app.post("/kb/trades/batch")
async def record_trades_batch(body: list[dict]):
    """Record a batch of trade outcomes and execution audits."""
    if not isinstance(body, list):
        raise HTTPException(400, "Expected a JSON array")
    results = []
    for item in body[:200]:
        if not isinstance(item, dict):
            continue
        side = item.get("positionSide") or item.get("position_side") or item.get("side")
        if not item.get("symbol") or not side:
            continue
        eligibility = validate_learning_eligibility(item)
        source_id = _payload_source_id(item)
        if not eligibility.learning_eligible:
            results.append({
                "sourceId": source_id,
                "recorded": False,
                "duplicate": False,
                "blockedReasons": eligibility.blocked_reasons,
            })
            continue
        experiment = await infer_assignment_for_outcome(item) or {}
        duplicate = await _trade_outcome_exists(source_id)
        record_args = trade_payload_to_record_args(item, experiment)
        if duplicate and _first_payload_value(item, "policyVersion", "policy_version") is None:
            record_args["policy_version"] = None
        recorded = await kb.record_trade_outcome(**record_args)
        audit = await record_trade_audit(item)
        results.append({
            "sourceId": str(record_args.get("source_id") or source_id),
            "recorded": bool(recorded or duplicate),
            "duplicate": duplicate,
            "blockedReasons": [],
            "experiment": experiment,
            "executionQuality": audit["executionQuality"],
        })
    _response_cache.clear()
    return {"ok": True, "count": len(results), "results": results, "items": results}


@app.get("/execution/audit")
async def get_execution_audit_endpoint(hours: int = Query(24, ge=1, le=720)):
    """Latency, slippage and execution-drag report for sniper fills."""
    return await get_execution_audit_report(hours=hours)


@app.get("/kb/trades/summary")
async def get_trade_source_summary():
    """Auditoria de resultados realizados separados por demo/live e origem."""
    return await kb.get_trade_source_summary()


@app.get("/kb/trades/recent")
async def get_recent_trade_outcomes(
    source: str = Query("all", pattern="^(all|demo|live)$"),
    limit: int = Query(500, ge=1, le=2000),
):
    """Trades realizados recentes em formato compatível com o dashboard."""
    return await kb.get_recent_trade_outcomes(source=source, limit=limit)


@app.get("/score-calibration/status")
@cache_response(ttl_seconds=20)
async def get_score_calibration_status(
    days: int = Query(30, ge=1, le=365),
    limit: int = Query(5000, ge=50, le=20000),
):
    """Score Truth Engine: compara scores operacionais contra PnL realizado."""
    rows = await kb.get_score_calibration_rows(days=days, limit=limit)
    return run_score_calibration(rows)


@app.get("/kb/feature-history/{symbol}")
@cache_response(ttl_seconds=60)
async def get_feature_history(symbol: str, hours: int = Query(24, ge=1, le=168)):
    """Histórico de snapshots de features para análise temporal."""
    sym = symbol.upper()
    if not sym.endswith("-USDT"):
        sym = sym + "-USDT"
    history = await kb.get_feature_history(sym, hours)
    return {"symbol": sym, "hours": hours, "count": len(history), "history": history}


# ========== RECOMMENDATION ==========

@app.post("/recommend/entry")
async def recommend_entry_endpoint(body: dict, days: int = Query(30, ge=1, le=365)):
    """Entry allow/reject recommendation in shadow mode by default."""
    if "symbol" not in body:
        raise HTTPException(400, "Required field: symbol")
    return await recommend_entry(body, days=days)


@app.post("/edge/evaluate")
async def evaluate_edge_endpoint(body: dict):
    """
    Authoritative edge gate (Judge Sniper + Coach Ranker dual layer).
    Judge blocks fatal conditions only; Coach scores and ranks.
    """
    if "symbol" not in body:
        raise HTTPException(400, "Required field: symbol")
    try:
        return await asyncio.wait_for(evaluate_edge_gate(body), timeout=25)
    except asyncio.TimeoutError:
        log.exception("edge evaluate timeout")
        return {
            "allow": True,
            "gateRejects": [],
            "score": 0.0,
            "authority": "quant-brain-degraded",
            "mode": "degraded_timeout",
            "error": "edge_evaluate_timeout",
        }
    except Exception as exc:
        log.exception("edge evaluate failed")
        return {
            "allow": True,
            "gateRejects": [],
            "score": 0.0,
            "authority": "quant-brain-degraded",
            "mode": "degraded_error",
            "error": f"{type(exc).__name__}: {exc}",
        }


@app.post("/position-sizing/evaluate")
async def evaluate_position_sizing_endpoint(body: dict):
    """Calculate compounding-aware margin/leverage for one candidate."""
    if "symbol" not in body:
        raise HTTPException(400, "Required field: symbol")
    return calculate_position_size(body)


@app.get("/position-sizing/status")
async def position_sizing_status_endpoint(
    source: str = Query("all", pattern="^(all|demo|live)$"),
    limit: int = Query(500, ge=1, le=2000),
    equity: float = Query(0.0, ge=0.0),
):
    """Risk-tier performance and compounding curve from recent realized trades."""
    trades = await kb.get_recent_trade_outcomes(source=source, limit=limit)
    inferred_equity = equity if equity > 0 else float(os.environ.get("POSITION_SIZING_EQUITY_FALLBACK", "1000"))
    return build_position_sizing_status(trades, inferred_equity, {})


@app.post("/cycle/rank")
async def rank_cycle_candidates(body: dict):
    """
    Coach Ranker batch endpoint.

    Receives all sniper cycle candidates in one request, runs Judge + Coach
    on each, and returns them sorted by executionPriority (highest first).

    Request body:
      candidates  — list of entry contexts (same schema as /edge/evaluate body)
      config      — shared bot config (applied to all candidates)
      btcRegime   — current BTC regime string (optional)
      btcChangePct — BTC price change % (optional)
      hourUtc     — current UTC hour (optional)

    Response:
      ranked      — list of {symbol, positionSide, allow, executionPriority,
                             judgeSniper, coachRanker, gateRejects, score, aggressiveScore}
      totalCandidates — int
      allowed     — int
      blocked     — int
    """
    candidates_raw = body.get("candidates")
    if not candidates_raw or not isinstance(candidates_raw, list):
        raise HTTPException(400, "Required field: candidates (non-empty list)")

    shared_config = body.get("config") or {}
    shared_btc_regime = body.get("btcRegime")
    shared_btc_change = body.get("btcChangePct")
    shared_hour = body.get("hourUtc")

    async def _evaluate_one(candidate: dict) -> dict:
        merged = {**candidate}
        if shared_config and "config" not in merged:
            merged["config"] = shared_config
        elif shared_config:
            merged["config"] = {**shared_config, **(merged.get("config") or {})}
        if shared_btc_regime and "btcRegime" not in merged:
            merged["btcRegime"] = shared_btc_regime
        if shared_btc_change is not None and "btcChangePct" not in merged:
            merged["btcChangePct"] = shared_btc_change
        if shared_hour is not None and "hourUtc" not in merged:
            merged["hourUtc"] = shared_hour
        try:
            result = await asyncio.wait_for(evaluate_edge_gate(merged), timeout=20)
        except asyncio.TimeoutError:
            result = {
                "allow": True, "gateRejects": [], "score": 0.0,
                "aggressiveScore": 0.0, "executionPriority": 0.0,
                "authority": "quant-brain-degraded", "mode": "degraded_timeout",
                "symbol": merged.get("symbol", ""), "positionSide": merged.get("positionSide", ""),
            }
        except Exception as exc:
            result = {
                "allow": True, "gateRejects": [], "score": 0.0,
                "aggressiveScore": 0.0, "executionPriority": 0.0,
                "authority": "quant-brain-degraded", "mode": "degraded_error",
                "error": f"{type(exc).__name__}: {exc}",
                "symbol": merged.get("symbol", ""), "positionSide": merged.get("positionSide", ""),
            }
        return result

    results = await asyncio.gather(*[_evaluate_one(c) for c in candidates_raw])

    allowed_results = [r for r in results if r.get("allow", True)]
    blocked_results = [r for r in results if not r.get("allow", True)]

    ranked = sorted(
        allowed_results,
        key=lambda r: float(r.get("executionPriority", r.get("score", 0.0))),
        reverse=True,
    )

    return {
        "ranked": ranked,
        "blocked": blocked_results,
        "totalCandidates": len(results),
        "allowed": len(allowed_results),
        "blockedCount": len(blocked_results),
        "mode": "judge-coach-dual-layer-v1",
    }


@app.get("/regime-playbook/status")
@cache_response(ttl_seconds=10)
async def regime_playbook_status_endpoint(days: int = Query(30, ge=1, le=365)):
    """
    Current regime/playbook map plus historical performance by playbook.
    """
    snaps = engine.get_all_snapshots()
    btc_snap = snaps.get("BTC-USDT")
    performance = await kb.get_playbook_performance(days=days)
    report = await kb.get_playbook_report(days=days)
    breadth_values = [
        snap.price_change_pct
        for symbol, snap in snaps.items()
        if symbol != "BTC-USDT"
    ]
    market_breadth = (
        sum(1 for value in breadth_values if value > 0) / len(breadth_values)
        if breadth_values
        else 0.5
    )

    active_by_symbol: dict[str, Any] = {}
    for symbol, snap in snaps.items():
        if symbol == "BTC-USDT":
            continue
        try:
            alt_history = get_snapshot_history(symbol, 900)
            btc_history = get_snapshot_history("BTC-USDT", 900)
            sniper = evaluate_sniper_window(
                symbol,
                alt_history,
                btc_history,
                target_moves_pct={"configured": 0.3, "0.5": 0.5, "1.0": 1.0, "2.0": 2.0},
            )
            alt_features = sniper.get("altFeatures") or {}
            correlation = 0.0
            sample_count = min(len(alt_history), len(btc_history), 60)
            if sample_count >= 10:
                alt_change = float(alt_history[-1].get("price_change_pct", 0) or 0)
                btc_change = float(btc_history[-1].get("price_change_pct", 0) or 0)
                correlation = 0.6 if alt_change * btc_change > 0 else 0.2
            spread_bps = float(alt_features.get("spread_bps") or snap.spread_bps or 0)
            liquidity_score = max(0.0, min(1.0, 1.0 - spread_bps / 30.0))
            news_context = await kb.get_active_news_context(symbol)
            active_by_symbol[symbol] = classify_regime_playbook(
                symbol=symbol,
                position_side="LONG" if snap.price_change_pct >= 0 else "SHORT",
                btc_regime=(btc_snap.btc_regime if btc_snap else snap.btc_regime),
                btc_volatility_pct=(btc_snap.atr_pct if btc_snap else 0.0),
                btc_trend_strength=(btc_snap.price_change_pct if btc_snap else 0.0),
                alt_btc_correlation=correlation,
                symbol_momentum=float(alt_features.get("price_change_pct") or snap.price_change_pct),
                volume_ratio=float(alt_features.get("volume_ratio") or snap.volume_ratio),
                oi_change_pct=float(alt_features.get("oi_change_pct") or snap.oi_change_pct),
                spread_bps=spread_bps,
                liquidity_score=liquidity_score,
                candle_context=sniper.get("altTimeframes") or {},
                market_breadth=market_breadth,
                funding_rate=float(alt_features.get("funding_rate") or snap.funding_rate),
                news_context=news_context,
                operational_risk=_runtime_state.get("operational_risk") or {},
                playbook_performance=performance,
            )
        except Exception as exc:
            active_by_symbol[symbol] = {
                "regime": "LOW_LIQUIDITY",
                "playbook": "AVOID_MODE",
                "allowedSetups": [],
                "blockedSetups": ["UNKNOWN_DATA_QUALITY"],
                "scoreAdjustments": {"minScoreBoost": 0.16},
                "error": f"{type(exc).__name__}: {exc}",
            }

    current_regimes: dict[str, int] = defaultdict(int)
    for item in active_by_symbol.values():
        current_regimes[str(item.get("regime", "UNKNOWN"))] += 1

    return {
        "timestamp": time.time(),
        "regimeCurrent": dict(current_regimes),
        "activeBySymbol": active_by_symbol,
        "allowedPlaybooks": [
            "MOMENTUM_BREAKOUT_SCALP",
            "PULLBACK_CONTINUATION",
            "RANGE_QUICK_SCALP",
            "LIQUIDITY_SWEEP_REVERSAL",
            "BTC_LEAD_ALT_FOLLOW",
            "AVOID_MODE",
        ],
        "performanceByPlaybook": performance,
        "report": report,
    }


# ========== SIGNALS ==========

@app.post("/signals/finalize")
async def finalize_signals_endpoint():
    """Finalize pending signal outcomes after the 300s sniper validation window."""
    return await finalize_due_signal_outcomes()


@app.post("/signal/lifecycle")
async def record_signal_lifecycle_event(body: dict):
    """Record a signal lifecycle event from the trading bot (fire-and-forget from API server)."""
    for r in ("eventType", "symbol", "side"):
        if r not in body:
            raise HTTPException(400, f"Required field: {r}")
    score_raw = body.get("score")
    await kb.record_lifecycle_event(
        event_type=str(body["eventType"]),
        symbol=str(body["symbol"]),
        side=str(body["side"]),
        signal_id=body.get("signalId"),
        score=float(score_raw) if score_raw is not None else None,
        risk_profile=body.get("riskProfile"),
        is_demo=bool(body.get("isDemo", True)),
        metadata=body.get("metadata"),
    )
    return {"ok": True}


@app.get("/metrics/learning")
@cache_response(ttl_seconds=30)
async def get_learning_metrics_endpoint(hours: int = Query(24, ge=1, le=168)):
    """
    Learning velocity and score-bucket metrics.
    Use this to verify whether high-score trades outperform low-score trades
    — the primary signal that the Coach Ranker is becoming a real teacher.
    """
    return await kb.get_learning_metrics(hours=hours)


# ── Exit Intelligence endpoints ──────────────────────────────────────────────

@app.post("/exit/evaluate")
async def exit_evaluate_endpoint(body: dict):
    """
    Evaluate an open position and recommend an exit action.

    Called by the demo monitor every cycle for each open position.
    Fetches current market data internally (snapshot history + sniper window).
    Never blocks — returns HOLD on any internal error.
    """
    symbol = body.get("symbol", "")
    position_side = body.get("positionSide") or body.get("position_side") or "LONG"
    if not symbol:
        raise HTTPException(400, "symbol required")

    try:
        result = evaluate_exit(
            symbol=symbol.upper(),
            position_side=str(position_side).upper(),
            entry_price=float(body.get("entryPrice", body.get("entry_price", 0))),
            current_price=float(body.get("currentPrice", body.get("current_price", 0))),
            unrealized_pnl_pct=float(body.get("unrealizedPnlPct", body.get("unrealized_pnl_pct", 0))),
            age_seconds=float(body.get("ageSeconds", body.get("age_seconds", 0))),
            tp_pct=float(body.get("tpPct", body.get("tp_pct", 0.3))),
            sl_pct=float(body.get("slPct", body.get("sl_pct", 0.2))),
            mfe_pct=float(body.get("mfePct", body.get("mfe_pct", 0))),
            mae_pct=float(body.get("maePct", body.get("mae_pct", 0))),
            aggressive_score=float(body.get("aggressiveScore", body.get("aggressive_score", 0.5))),
            campaign_depth=int(body.get("campaignDepth", body.get("campaign_depth", 1))),
            campaign_drawdown_pct=float(body.get("campaignDrawdownPct", body.get("campaign_drawdown_pct", 0))),
            btc_regime=str(body.get("btcRegime", body.get("btc_regime", "NEUTRAL"))),
            regime_playbook=body.get("regimePlaybook") or {},
            playbook=body.get("playbook"),
        )
    except Exception as exc:
        # Never crash the monitor — return safe HOLD
        return {
            "action": "HOLD",
            "confidence": 0.5,
            "reason": f"evaluation_error: {exc}",
            "shouldClose": False,
            "shouldStack": True,
            "stackingAction": None,
            "protectionLevel": "normal",
            "suggestedStopPct": float(body.get("slPct", 0.2)),
            "suggestedTakeProfitPct": float(body.get("tpPct", 0.3)),
            "adaptiveTpSl": {"tpPct": float(body.get("tpPct", 0.3)), "slPct": float(body.get("slPct", 0.2)), "rationale": "fallback"},
            "context": {},
            "version": "exit-intelligence-v1",
        }

    # Persist evaluation for outcome correlation (fire-and-forget — don't let
    # DB errors block the response)
    source_id = str(body.get("orderId") or "")
    if source_id:
        try:
            await record_exit_evaluation(
                source_id=source_id,
                symbol=symbol.upper(),
                side=str(position_side).upper(),
                action=result["action"],
                confidence=float(result["confidence"]),
                reason=str(result["reason"]),
                suggested_stop_pct=float(result["suggestedStopPct"]),
                suggested_tp_pct=float(result["suggestedTakeProfitPct"]),
                should_close=result["shouldClose"],
                should_stack=result["shouldStack"],
                protection_level=str(result["protectionLevel"]),
                unrealized_pnl_pct=float(body.get("unrealizedPnlPct", 0)),
                mfe_pct=float(body.get("mfePct", 0)),
                age_seconds=float(body.get("ageSeconds", 0)),
                momentum_score=float((result.get("context") or {}).get("momentumScore", 0.5)),
            )
        except Exception:
            pass

    return result


@app.post("/exit/record-outcome")
async def exit_record_outcome_endpoint(body: dict):
    """
    Record post-trade exit outcome for learning analysis.

    Called after a demo trade closes. Classifies exit quality and persists
    for Coach Ranker feedback.
    """
    required = ["sourceId", "symbol", "pnlPct", "mfePct", "maePct", "ageSeconds", "tpPct", "slPct", "exitReason"]
    for r in required:
        if r not in body:
            raise HTTPException(400, f"Required field: {r}")
    side = body.get("positionSide") or body.get("side") or "LONG"
    try:
        experiment = await infer_assignment_for_outcome(body) or {}
        result = await _record_exit_outcome(
            source_id=str(body["sourceId"]),
            symbol=str(body["symbol"]).upper(),
            side=str(side).upper(),
            is_demo=bool(body.get("isDemo", True)),
            entry_price=float(body.get("entryPrice", 0)),
            exit_price=float(body.get("exitPrice", 0)),
            pnl_pct=float(body["pnlPct"]),
            mfe_pct=float(body["mfePct"]),
            mae_pct=float(body["maePct"]),
            age_seconds=float(body["ageSeconds"]),
            tp_pct=float(body["tpPct"]),
            sl_pct=float(body["slPct"]),
            exit_reason=str(body["exitReason"]),
            exit_action_taken=str(body.get("exitActionTaken") or ""),
            entry_aggressive_score=float(body.get("aggressiveScore", 0)),
            btc_regime=str(body.get("btcRegime") or "NEUTRAL"),
            hour_utc=int(body.get("hourUtc", 0)),
            campaign_id=str(body.get("campaignId") or ""),
            experiment_id=str(experiment.get("experimentId") or ""),
            experiment_arm=str(experiment.get("experimentArm") or ""),
            policy_version=str(experiment.get("policyVersion") or ""),
            expected_duration_sec=float(body.get("expectedDurationSec", 300)),
        )
        _response_cache.clear()
        return {"ok": True, **result, "experiment": experiment}
    except Exception as exc:
        raise HTTPException(500, f"Failed to record exit outcome: {exc}") from exc


@app.get("/exit/stats")
@cache_response(ttl_seconds=60)
async def exit_stats_endpoint(
    symbol: str | None = Query(None),
    side: str | None = Query(None),
    days: int = Query(30, ge=1, le=365),
):
    """
    Exit quality analytics — win-rate / PnL / MFE averages by label and action.
    Used by the Intelligence page and Coach Ranker learning signal.
    """
    return await get_exit_stats(
        symbol=symbol.upper() if symbol else None,
        side=side.upper() if side else None,
        days=days,
    )


@app.post("/models/sniper/train")
async def train_sniper_model_endpoint(min_samples: int = Query(300, ge=100, le=100000)):
    """Train and validate the calibrated sniper model; authority remains shadow-only."""
    return await train_shadow_model(min_samples=min_samples)


@app.get("/models/sniper/status")
@cache_response(ttl_seconds=10)
async def sniper_model_status_endpoint():
    await finalize_due_signal_outcomes()
    await restore_shadow_model()
    status = shadow_model_status()
    progress = await kb.get_signal_training_summary(decision_group=None, source_type=None)
    pipeline = await kb.get_signal_pipeline_summary()
    sources = await kb.get_signal_source_summary()
    recent_shadow = await kb.get_recent_signal_outcomes(limit=10, source_type="shadow_sampler")
    samples = int(progress["samples"])
    sampler_st = shadow_sampler_status()
    cycles = int(sampler_st.get("cycles", 0) or 0)
    recorded = int(sampler_st.get("recorded", 0) or 0)
    interval = int(sampler_st.get("intervalSeconds", 60) or 60)
    samples_per_hour = round((recorded / cycles) * (3600 / interval)) if cycles > 0 else 0
    pending = int(pipeline.get("pending", 0) or 0)
    samples_needed = max(0, 300 - samples - pending)
    eta_hours = round(samples_needed / samples_per_hour, 2) if samples_per_hour > 0 else None

    return {
        **status,
        "samples": int(status.get("samples", samples) or samples),
        "trainingSamplesAvailable": samples,
        "minSamples": 300,
        "samplesRemaining": max(0, 300 - samples),
        "hits": progress["hits"],
        "misses": progress["misses"],
        "hasBothClasses": progress["hasBothClasses"],
        "trainingMode": "automatic_shadow",
        "signalPipeline": pipeline,
        "signalSources": sources,
        "shadowSampler": sampler_st,
        "macroCandleRegime": candle_regime_status(),
        "recentShadowSignals": recent_shadow,
        "learningVelocity": {
            "samplesPerHour": samples_per_hour,
            "etaHours": eta_hours,
            "recordedTotal": recorded,
            "cycles": cycles,
        },
    }


@app.get("/signals/shadow-sampler/status")
async def shadow_sampler_status_endpoint():
    return {
        "sampler": shadow_sampler_status(),
        "pipeline": await kb.get_signal_pipeline_summary(),
        "sources": await kb.get_signal_source_summary(),
        "recent": await kb.get_recent_signal_outcomes(limit=20, source_type="shadow_sampler"),
    }


@app.get("/sniper/reconciliation/status")
@app.get("/api/sniper/reconciliation/status")
async def sniper_reconciliation_status_endpoint(
    days: int = Query(30, ge=1, le=365),
    limit: int = Query(10000, ge=1, le=50000),
):
    """Shadow/demo/live reconciliation status for sniper promotion evidence."""
    await finalize_due_signal_outcomes()
    return await kb.get_sniper_reconciliation_status(days=days, limit=limit)


@app.post("/signals/shadow-sampler/run")
async def run_shadow_sampler_once_endpoint():
    result = await sample_shadow_signals_once(engine)
    return {
        "ok": True,
        "sampler": shadow_sampler_status(),
        **result,
    }


@app.get("/signals/edge/{symbol}")
@cache_response(ttl_seconds=30)
async def get_signal_edge_endpoint(
    symbol: str,
    side: str = Query("LONG"),
    context_key: str = Query(None),
    decision_group: str = Query("ALLOW"),
    source_type: str = Query("hypothetical"),
):
    """Target-hit memory for sniper signals, including blocked/wait decisions."""
    sym = symbol.upper()
    if not sym.endswith("-USDT"):
        sym = f"{sym}-USDT"
    return await score_signal_context(
        sym,
        side.upper(),
        context_key or "",
        decision_group=decision_group.upper(),
        source_type=source_type.lower(),
    )


# ========== NEWS ==========

@app.post("/news/events")
async def record_news_event_endpoint(body: dict):
    """Store a market/news event as risk context for the edge gate."""
    title = str(body.get("title", "")).strip()
    if not title:
        raise HTTPException(400, "Required field: title")
    symbols = body.get("symbols") or body.get("affectedSymbols") or ["MARKET"]
    if isinstance(symbols, str):
        symbols = [symbols]
    normalized = []
    for item in symbols:
        sym = str(item).upper()
        if sym not in {"MARKET", "BTC-USDT"} and sym.endswith("USDT") and "-" not in sym:
            sym = f"{sym[:-4]}-USDT"
        normalized.append(sym)
    await kb.record_news_event(
        source=str(body.get("source", "manual")),
        title=title,
        symbols=normalized,
        category=str(body.get("category", "market")),
        impact_score=float(body.get("impactScore", body.get("impact_score", 0))),
        risk_level=str(body.get("riskLevel", body.get("risk_level", "LOW"))).upper(),
        action=str(body.get("action", "context_only")),
        url=str(body.get("url", "")),
        raw=body,
        ttl_seconds=int(body.get("ttlSeconds", body.get("ttl_seconds", 7200))),
    )
    return {"ok": True, "symbols": normalized}


@app.get("/news/context/{symbol}")
@cache_response(ttl_seconds=30)
async def get_news_context_endpoint(symbol: str):
    """Active news/sentiment risk context for a symbol."""
    sym = symbol.upper()
    if not sym.endswith("-USDT") and sym != "MARKET":
        sym = f"{sym}-USDT"
    return await kb.get_active_news_context(sym)


@app.get("/simulate/gate-rejections")
@cache_response(ttl_seconds=60)
async def simulate_gate_rejections_endpoint(
    days: int = Query(30, ge=1, le=365),
    min_avg_pnl: float = Query(0.0),
):
    """Backtest-style simulation for rejecting losing flow by symbol, hour, or regime."""
    return await simulate_gate_rejections(days=days, min_avg_pnl=min_avg_pnl)


# ========== HEALTH ==========

@app.get("/health")
@cache_response(ttl_seconds=5)
async def health():
    snaps = engine.get_all_snapshots()
    return {
        "status": "ok" if _runtime_state["services_started"] else "initializing",
        "ai_enabled": _has_ai(),
        "symbols_monitored": len(SYMBOLS),
        "snapshots_cached": len(snaps),
        "database_ready": _runtime_state["database_ready"],
        "database_backend": "postgresql" if using_postgres() else "sqlite",
        "database_schema": database_schema() if using_postgres() else None,
        "services_started": _runtime_state["services_started"],
        "startup_error": _runtime_state["startup_error"],
        "jobs": job_supervisor.status(),
        "uptime_seconds": round(
            time.time() - float(_runtime_state["started_at"]),
            3,
        ),
    }


@app.get("/")
async def root():
    return {
        "name": "Quant Brain",
        "version": "2.0.0",
        "description": "Motor de análise quantitativa 24h para 10 ativos BingX",
        "status": "operational",
        "ai_enabled": _has_ai(),
        "endpoints": {
            "market": ["/market/snapshots", "/market/anomalies"],
            "sniper": ["/sniper/btc-commander", "/sniper/evaluate/{symbol}"],
            "tactical": ["/tactical/alerts", "/tactical/analyze"],
            "strategic": ["/strategic/report", "/strategic/analyze", "/strategic/hypotheses"],
            "knowledge_base": ["/kb/patterns", "/kb/observations", "/kb/insights", "/kb/stats", "/kb/trades"],
            "recommendation": ["/recommend/entry", "/simulate/gate-rejections"],
            "edge_gate": ["/edge/evaluate"],
            "signals": ["/signals/finalize", "/signals/edge/{symbol}"],
            "news": ["/news/events", "/news/context/{symbol}"],
            "metrics": ["/metrics", "/health/live", "/health/ready"],
        }
    }
