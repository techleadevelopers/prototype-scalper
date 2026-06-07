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
from core.job_supervisor import JobSupervisor
from core.candle_regime import analyze_macro_candle_regime, candle_regime_status
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
    required = ["symbol"]
    for r in required:
        if r not in body:
            raise HTTPException(400, f"Campo obrigatório: {r}")
    side = body.get("positionSide") or body.get("position_side") or body.get("side")
    if not side:
        raise HTTPException(400, "Required field: side or positionSide")
    pnl_pct = body.get("pnl_pct")
    if pnl_pct is None:
        realized_pnl = float(body.get("realizedPnl", body.get("realized_pnl", 0)))
        margin_used = float(body.get("marginUsed", body.get("margin_used", 0)))
        pnl_pct = (realized_pnl / margin_used * 100) if margin_used > 0 else realized_pnl

    pnl_usdt = body.get("pnl_usdt", body.get("realizedPnl", 0))

    recorded = await kb.record_trade_outcome(
        source_id=str(body.get("id") or "") or None,
        source=str(body.get("source") or "manual"),
        is_demo=bool(body.get("isDemo", body.get("is_demo", False))),
        symbol=body["symbol"],
        side=side,
        pnl_pct=float(pnl_pct),
        pnl_usdt=float(pnl_usdt) if pnl_usdt else 0.0,
        entry_price=float(body.get("entry_price", body.get("entryPrice", 0))),
        exit_price=float(body.get("exit_price", body.get("exitPrice", 0))),
        oi_change=float(body.get("oi_change", body.get("oiChange", 0))),
        funding=float(body.get("funding", body.get("fundingRate", 0))),
        volume_ratio=float(body.get("volume_ratio", body.get("volumeRatio", 1))),
        btc_regime=body.get("btc_regime", body.get("btcRegime", "NEUTRAL")),
        rsi=float(body.get("rsi", body.get("rsiAtEntry", 50))),
        ema_cross=body.get("ema_cross", body.get("emaCross", "FLAT")),
        slippage_bps=float(body.get("slippage_bps", body.get("slippageBps", 0))),
        fee_paid_usdt=float(body.get("fee_paid_usdt", body.get("feePaidUsdt", 0))),
    )

    # Invalida cache relacionado
    _response_cache.clear()

    return {
        "ok": True,
        "recorded": recorded,
        "symbol": body["symbol"],
        "pnl_pct": float(pnl_pct),
    }


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
    """Authoritative edge gate: backend sends pending entry context, Quant Brain returns allow/reject."""
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


# ========== SIGNALS ==========

@app.post("/signals/finalize")
async def finalize_signals_endpoint():
    """Finalize pending signal outcomes after the 300s sniper validation window."""
    return await finalize_due_signal_outcomes()


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
