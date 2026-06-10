from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from pathlib import Path
from typing import Any

from core.candle_regime import candle_regime_status
from core.async_utils import run_blocking
from core.feature_engine import FeatureEngine, SYMBOLS
from core.movement_sniper import evaluate_sniper_window
from core.signal_learning import record_signal_from_gate
from layers.tactical import get_snapshot_history, process_tactical_cycle

log = logging.getLogger("shadow_sampler")


SHADOW_SAMPLER_SOURCE_TYPE = "shadow_sampler"
DATA_DIR = Path(__file__).parent.parent / "data"
STATE_FILE = Path(os.environ.get("SHADOW_SAMPLER_STATE_PATH", DATA_DIR / "shadow-sampler-state.json"))
MAX_LAST_ANALYSES = 40
DEFAULT_SHADOW_SYMBOLS = [
    "BTC-USDT",
    "ETH-USDT",
    "SOL-USDT",
    "NEAR-USDT",
    "HYPE-USDT",
    "POL-USDT",
]

_sampler_state: dict[str, Any] = {
    "enabled": True,
    "running": False,
    "intervalSeconds": 60,
    "lastRunAt": 0.0,
    "lastError": None,
    "cycles": 0,
    "attempted": 0,
    "recorded": 0,
    "deduped": 0,
    "rejectedZeroPrice": 0,
    "insertFailed": 0,
    "skippedNoData": 0,
    "bootstrapCycles": 0,
    "lastAnalyses": [],
    # Sniper Quality Filter (elevação para nível industrial)
    "sniperFiltered": 0,   # sinais rejeitados por qualidade insuficiente
    "sniperPassed": 0,     # sinais que passaram no filtro sniper
    "lastIntelligenceAnalyses": [],  # apenas sinais de qualidade (ARM_TRIGGER + score)
}


def _persist_sampler_state() -> None:
    try:
        STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        payload = dict(_sampler_state)
        tmp = STATE_FILE.with_suffix(f"{STATE_FILE.suffix}.tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        tmp.replace(STATE_FILE)
    except Exception as exc:
        log.warning("Failed to persist shadow sampler state: %s", exc)


def _load_sampler_state() -> None:
    try:
        if not STATE_FILE.exists():
            return
        raw = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            return
        for key in (
            "intervalSeconds",
            "lastRunAt",
            "lastError",
            "cycles",
            "attempted",
            "recorded",
            "deduped",
            "rejectedZeroPrice",
            "insertFailed",
            "skippedNoData",
            "bootstrapCycles",
            "lastAnalyses",
            "sniperFiltered",
            "sniperPassed",
            "lastIntelligenceAnalyses",
        ):
            if key in raw:
                _sampler_state[key] = raw[key]
        if isinstance(_sampler_state.get("lastAnalyses"), list):
            _sampler_state["lastAnalyses"] = _sampler_state["lastAnalyses"][:MAX_LAST_ANALYSES]
        else:
            _sampler_state["lastAnalyses"] = []
        if isinstance(_sampler_state.get("lastIntelligenceAnalyses"), list):
            _sampler_state["lastIntelligenceAnalyses"] = _sampler_state["lastIntelligenceAnalyses"][:MAX_LAST_ANALYSES]
        else:
            _sampler_state["lastIntelligenceAnalyses"] = []
        _sampler_state["running"] = False
        _sampler_state["enabled"] = _env_bool("SHADOW_SAMPLER_ENABLED", True)
    except Exception as exc:
        log.warning("Failed to load shadow sampler state: %s", exc)


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


def _sniper_quality_passes(sniper: dict[str, Any]) -> bool:
    """
    Filtro de qualidade sniper — salva apenas inteligência, filtra lixo.

    ARM_TRIGGER + score >= SHADOW_SAMPLER_MIN_SCORE → intelligence-grade signal.
    Sinais WAIT ou score baixo ainda são gravados para treinamento (exemplos negativos),
    mas são marcados como 'intelligence=False' e ficam fora de lastIntelligenceAnalyses.

    Env vars:
      SHADOW_SAMPLER_MIN_SCORE  — score mínimo para intelligence (default: 0.55)
      SHADOW_SAMPLER_ARM_ONLY   — exige ARM_TRIGGER para intelligence (default: true)
    """
    decision = str(sniper.get("decision", "WAIT"))
    score = float(sniper.get("score") or 0.0)
    min_score = _env_float("SHADOW_SAMPLER_MIN_SCORE", 0.55)
    arm_only = _env_bool("SHADOW_SAMPLER_ARM_ONLY", True)

    if arm_only and decision != "ARM_TRIGGER":
        return False
    return score >= min_score


def _sampler_symbols() -> list[str]:
    raw = os.environ.get("SHADOW_SAMPLER_SYMBOLS", "").strip()
    if not raw:
        raw = ",".join(DEFAULT_SHADOW_SYMBOLS)
    symbols = [symbol.strip().upper() for symbol in raw.split(",") if symbol.strip()]
    return symbols or list(DEFAULT_SHADOW_SYMBOLS)


def _sampler_config() -> dict[str, Any]:
    return {
        "marginPerTrade": _env_float("SHADOW_SAMPLER_MARGIN_PER_TRADE", 5.0),
        "leverage": _env_float("SHADOW_SAMPLER_LEVERAGE", 14.0),
        "takeProfitPct": _env_float("SHADOW_SAMPLER_TAKE_PROFIT_PCT", 0.22),
        "stopLossPct": _env_float("SHADOW_SAMPLER_STOP_LOSS_PCT", 0.55),
        "takerFeeBps": _env_float("SHADOW_SAMPLER_TAKER_FEE_BPS", 5.0),
        "slippageBpsPerSide": _env_float("SHADOW_SAMPLER_SLIPPAGE_BPS_PER_SIDE", 2.0),
        "estimatedFundingCostPct": _env_float("SHADOW_SAMPLER_ESTIMATED_FUNDING_COST_PCT", 0.0),
        "signalDedupeSeconds": _env_int("SHADOW_SAMPLER_DEDUPE_SECONDS", 60),
        "signalSourceType": SHADOW_SAMPLER_SOURCE_TYPE,
    }


def shadow_sampler_status() -> dict[str, Any]:
    return dict(_sampler_state)


def reconcile_shadow_sampler_status(
    *,
    observed: int,
    latest_created_at: float = 0.0,
    recent: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Recover dashboard counters from durable signal_outcomes rows."""
    changed = False
    observed = max(0, int(observed or 0))
    latest_created_at = float(latest_created_at or 0)

    if observed > int(_sampler_state.get("recorded", 0) or 0):
        _sampler_state["recorded"] = observed
        _sampler_state["attempted"] = max(int(_sampler_state.get("attempted", 0) or 0), observed)
        changed = True

    if observed > 0 and int(_sampler_state.get("cycles", 0) or 0) <= 0:
        symbols_per_cycle = max(1, len(_sampler_symbols()) * 2)
        _sampler_state["cycles"] = max(1, (observed + symbols_per_cycle - 1) // symbols_per_cycle)
        changed = True

    if latest_created_at > float(_sampler_state.get("lastRunAt", 0) or 0):
        _sampler_state["lastRunAt"] = latest_created_at
        changed = True

    if recent and not _sampler_state.get("lastAnalyses"):
        analyses: list[dict[str, Any]] = []
        for row in recent[:MAX_LAST_ANALYSES]:
            analyses.append({
                "symbol": row.get("symbol"),
                "fallbackSide": row.get("side"),
                "recorded": True,
                "decision": row.get("decision"),
                "score": None,
                "target": None,
                "expectedTimeToTargetSec": None,
                "risk": None,
                "momentumQuality": None,
                "microstructureToxicity": None,
                "altMovePct": None,
                "btcMovePct": None,
                "btcCommander": None,
                "reasons": [],
                "capturedAt": float(row.get("created_at") or 0),
            })
        _sampler_state["lastAnalyses"] = analyses
        changed = True

    enabled = _env_bool("SHADOW_SAMPLER_ENABLED", True)
    _sampler_state["enabled"] = enabled
    if enabled and not _sampler_state.get("lastError"):
        _sampler_state["running"] = True
    if changed:
        _persist_sampler_state()
    return shadow_sampler_status()


def _compact_analysis(
    symbol: str,
    fallback_side: str,
    sniper: dict[str, Any],
    recorded: bool,
    record_status: str,
    intelligence: bool = False,
) -> dict[str, Any]:
    alt = sniper.get("altFeatures", {}) or {}
    btc = sniper.get("btcFeatures", {}) or {}
    return {
        "symbol": symbol,
        "fallbackSide": fallback_side,
        "recorded": recorded,
        "recordStatus": record_status,
        "intelligence": intelligence,
        "decision": sniper.get("decision"),
        "score": sniper.get("score"),
        "target": sniper.get("target"),
        "expectedTimeToTargetSec": sniper.get("expectedTimeToTargetSec"),
        "risk": sniper.get("risk"),
        "momentumQuality": sniper.get("momentumQuality"),
        "microstructureToxicity": sniper.get("microstructureToxicity"),
        "altMovePct": alt.get("price_change_pct"),
        "btcMovePct": btc.get("price_change_pct"),
        "btcCommander": sniper.get("btcCommander"),
        "reasons": list(sniper.get("reasons", []))[:8],
        "capturedAt": time.time(),
    }


async def sample_shadow_signals_once(engine: FeatureEngine) -> dict[str, Any]:
    config = _sampler_config()
    window_seconds = _env_int("SHADOW_SAMPLER_WINDOW_SECONDS", 300)
    bootstrap_samples = max(3, _env_int("SHADOW_SAMPLER_BOOTSTRAP_SAMPLES", 3))
    symbols = _sampler_symbols()
    symbol_concurrency = max(1, _env_int("SHADOW_SAMPLER_SYMBOL_CONCURRENCY", 6))
    symbol_semaphore = asyncio.Semaphore(symbol_concurrency)

    cycle_num = int(_sampler_state["cycles"]) + 1
    log.info("Shadow sampler cycle=%d starting for %d symbols", cycle_num, len(symbols))

    if not engine.get_all_snapshots():
        await process_tactical_cycle(engine)

    btc_history = get_snapshot_history("BTC-USDT", max(window_seconds, 900))
    if len(btc_history) < bootstrap_samples:
        needed = bootstrap_samples - len(btc_history)
        log.info("Shadow sampler bootstrap: need %d more BTC snapshots", needed)
        for _ in range(needed):
            await process_tactical_cycle(engine)
            _sampler_state["bootstrapCycles"] = int(_sampler_state["bootstrapCycles"]) + 1
            await asyncio.sleep(0.25)

    regime = candle_regime_status()
    btc_regime = (regime.get("symbols") or {}).get("BTC-USDT", {})

    async def evaluate_symbol_unbounded(symbol: str) -> dict[str, Any]:
        result: dict[str, Any] = {
            "attempted": 0,
            "recorded": 0,
            "deduped": 0,
            "rejectedZeroPrice": 0,
            "insertFailed": 0,
            "skippedNoData": 0,
            "sniperFiltered": 0,
            "sniperPassed": 0,
            "analyses": [],
            "intelligenceAnalyses": [],
        }
        sym = symbol if symbol.endswith("-USDT") else f"{symbol}-USDT"
        alt_history = get_snapshot_history(sym, max(window_seconds, 900))
        btc_history = get_snapshot_history("BTC-USDT", max(window_seconds, 900))
        if len(alt_history) < bootstrap_samples or len(btc_history) < bootstrap_samples:
            log.debug(
                "Shadow sampler skip %s: alt_history=%d btc_history=%d (need %d)",
                sym, len(alt_history), len(btc_history), bootstrap_samples,
            )
            result["skippedNoData"] = 1
            return result

        sniper = await run_blocking(
            evaluate_sniper_window,
            sym,
            alt_history,
            btc_history,
            window_seconds=window_seconds,
        )
        sniper["candleRegime"] = btc_regime

        # ── Sniper Quality Filter ──────────────────────────────────────────────────
        # Determina se este símbolo possui sinal de inteligência neste ciclo.
        # Sinais de baixa qualidade ainda são gravados no banco para treinamento
        # (exemplos negativos são essenciais para o shadow model), mas ficam de
        # fora de lastIntelligenceAnalyses no dashboard.
        is_intelligence = _sniper_quality_passes(sniper)
        if is_intelligence:
            result["sniperPassed"] += 1
            log.debug(
                "Shadow sampler INTELLIGENCE %s: decision=%s score=%.3f",
                sym, sniper.get("decision"), sniper.get("score") or 0,
            )
        else:
            result["sniperFiltered"] += 1
            log.debug(
                "Shadow sampler FILTERED %s: decision=%s score=%.3f (below quality bar)",
                sym, sniper.get("decision"), sniper.get("score") or 0,
            )
        # ─────────────────────────────────────────────────────────────────────────

        for fallback_side in ("LONG", "SHORT"):
            result["attempted"] += 1
            signal = await record_signal_from_gate(sym, fallback_side, sniper, config)
            was_recorded = bool(signal.get("recorded"))
            record_status = str(signal.get("recordStatus") or ("recorded" if was_recorded else "unknown"))
            result["recorded"] += 1 if was_recorded else 0
            if record_status == "deduped":
                result["deduped"] += 1
            elif record_status == "zero_entry_price":
                result["rejectedZeroPrice"] += 1
            elif record_status == "insert_failed":
                result["insertFailed"] += 1
                log.warning(
                    "Shadow sampler insert failed: symbol=%s side=%s signal_id=%s",
                    sym,
                    fallback_side,
                    signal.get("signalId"),
                )
            compact = _compact_analysis(sym, fallback_side, sniper, was_recorded, record_status, intelligence=is_intelligence)
            result["analyses"].append(compact)
            if is_intelligence and was_recorded:
                result["intelligenceAnalyses"].append(compact)
            await asyncio.sleep(0)
        return result

    async def evaluate_symbol(symbol: str) -> dict[str, Any]:
        async with symbol_semaphore:
            return await evaluate_symbol_unbounded(symbol)

    symbol_results = await asyncio.gather(*[evaluate_symbol(symbol) for symbol in symbols])
    attempted = sum(int(item["attempted"]) for item in symbol_results)
    recorded = sum(int(item["recorded"]) for item in symbol_results)
    deduped = sum(int(item["deduped"]) for item in symbol_results)
    rejected_zero_price = sum(int(item["rejectedZeroPrice"]) for item in symbol_results)
    insert_failed = sum(int(item["insertFailed"]) for item in symbol_results)
    skipped_no_data = sum(int(item["skippedNoData"]) for item in symbol_results)
    sniper_filtered = sum(int(item.get("sniperFiltered", 0)) for item in symbol_results)
    sniper_passed = sum(int(item.get("sniperPassed", 0)) for item in symbol_results)
    analyses = [
        analysis
        for item in symbol_results
        for analysis in item["analyses"]
    ]
    intelligence_analyses = [
        analysis
        for item in symbol_results
        for analysis in item.get("intelligenceAnalyses", [])
    ]

    log.info(
        "Shadow sampler cycle=%d done: attempted=%d recorded=%d deduped=%d zero_price=%d "
        "insert_failed=%d skipped=%d intelligence=%d/%d concurrency=%d",
        cycle_num, attempted, recorded, deduped, rejected_zero_price, insert_failed,
        skipped_no_data, sniper_passed, sniper_passed + sniper_filtered, symbol_concurrency,
    )

    previous_analyses = list(_sampler_state.get("lastAnalyses") or [])
    previous_intelligence = list(_sampler_state.get("lastIntelligenceAnalyses") or [])
    _sampler_state.update({
        "enabled": _env_bool("SHADOW_SAMPLER_ENABLED", True),
        "running": True,
        "lastRunAt": time.time(),
        "lastError": None,
        "cycles": cycle_num,
        "attempted": int(_sampler_state["attempted"]) + attempted,
        "recorded": int(_sampler_state["recorded"]) + recorded,
        "deduped": int(_sampler_state.get("deduped", 0) or 0) + deduped,
        "rejectedZeroPrice": int(_sampler_state.get("rejectedZeroPrice", 0) or 0) + rejected_zero_price,
        "insertFailed": int(_sampler_state.get("insertFailed", 0) or 0) + insert_failed,
        "skippedNoData": int(_sampler_state["skippedNoData"]) + skipped_no_data,
        "sniperFiltered": int(_sampler_state.get("sniperFiltered", 0) or 0) + sniper_filtered,
        "sniperPassed": int(_sampler_state.get("sniperPassed", 0) or 0) + sniper_passed,
        "lastAnalyses": (analyses + previous_analyses)[:MAX_LAST_ANALYSES],
        "lastIntelligenceAnalyses": (intelligence_analyses + previous_intelligence)[:MAX_LAST_ANALYSES],
    })
    _persist_sampler_state()

    return {
        "attempted": attempted,
        "recorded": recorded,
        "deduped": deduped,
        "rejectedZeroPrice": rejected_zero_price,
        "insertFailed": insert_failed,
        "skippedNoData": skipped_no_data,
        "sniperFiltered": sniper_filtered,
        "sniperPassed": sniper_passed,
        "intelligenceSignals": len(intelligence_analyses),
        "analyses": analyses,
        "intelligenceAnalyses": intelligence_analyses,
    }


async def run_shadow_signal_sampler(engine: FeatureEngine, interval_seconds: int = 60) -> None:
    enabled = _env_bool("SHADOW_SAMPLER_ENABLED", True)
    _sampler_state.update({
        "enabled": enabled,
        "running": enabled,
        "intervalSeconds": interval_seconds,
    })
    _persist_sampler_state()
    if not enabled:
        return

    while True:
        try:
            await sample_shadow_signals_once(engine)
        except asyncio.CancelledError:
            _sampler_state["running"] = False
            _persist_sampler_state()
            raise
        except Exception as exc:
            _sampler_state["lastError"] = f"{type(exc).__name__}: {exc}"
            _persist_sampler_state()

        await asyncio.sleep(interval_seconds)


_load_sampler_state()
