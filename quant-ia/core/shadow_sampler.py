from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Any

from core.candle_regime import candle_regime_status
from core.feature_engine import FeatureEngine, SYMBOLS
from core.movement_sniper import evaluate_sniper_window
from core.signal_learning import record_signal_from_gate
from layers.tactical import get_snapshot_history, process_tactical_cycle

log = logging.getLogger("shadow_sampler")


SHADOW_SAMPLER_SOURCE_TYPE = "shadow_sampler"

_sampler_state: dict[str, Any] = {
    "enabled": True,
    "running": False,
    "intervalSeconds": 60,
    "lastRunAt": 0.0,
    "lastError": None,
    "cycles": 0,
    "attempted": 0,
    "recorded": 0,
    "skippedNoData": 0,
    "bootstrapCycles": 0,
    "lastAnalyses": [],
}


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


def _sampler_config() -> dict[str, Any]:
    return {
        "marginPerTrade": _env_float("SHADOW_SAMPLER_MARGIN_PER_TRADE", 5.0),
        "leverage": _env_float("SHADOW_SAMPLER_LEVERAGE", 14.0),
        "takeProfitPct": _env_float("SHADOW_SAMPLER_TAKE_PROFIT_PCT", 0.22),
        "stopLossPct": _env_float("SHADOW_SAMPLER_STOP_LOSS_PCT", 0.55),
        "takerFeeBps": _env_float("SHADOW_SAMPLER_TAKER_FEE_BPS", 5.0),
        "slippageBpsPerSide": _env_float("SHADOW_SAMPLER_SLIPPAGE_BPS_PER_SIDE", 2.0),
        "estimatedFundingCostPct": _env_float("SHADOW_SAMPLER_ESTIMATED_FUNDING_COST_PCT", 0.0),
        "signalDedupeSeconds": _env_int("SHADOW_SAMPLER_DEDUPE_SECONDS", 300),
        "signalSourceType": SHADOW_SAMPLER_SOURCE_TYPE,
    }


def shadow_sampler_status() -> dict[str, Any]:
    return dict(_sampler_state)


def _compact_analysis(symbol: str, fallback_side: str, sniper: dict[str, Any], recorded: bool) -> dict[str, Any]:
    alt = sniper.get("altFeatures", {}) or {}
    btc = sniper.get("btcFeatures", {}) or {}
    return {
        "symbol": symbol,
        "fallbackSide": fallback_side,
        "recorded": recorded,
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
    symbols = [
        symbol.strip().upper()
        for symbol in os.environ.get("SHADOW_SAMPLER_SYMBOLS", ",".join(SYMBOLS)).split(",")
        if symbol.strip()
    ]

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

    attempted = 0
    recorded = 0
    skipped_no_data = 0
    analyses: list[dict[str, Any]] = []

    for symbol in symbols:
        sym = symbol if symbol.endswith("-USDT") else f"{symbol}-USDT"
        alt_history = get_snapshot_history(sym, max(window_seconds, 900))
        btc_history = get_snapshot_history("BTC-USDT", max(window_seconds, 900))
        if len(alt_history) < bootstrap_samples or len(btc_history) < bootstrap_samples:
            log.debug(
                "Shadow sampler skip %s: alt_history=%d btc_history=%d (need %d)",
                sym, len(alt_history), len(btc_history), bootstrap_samples,
            )
            skipped_no_data += 1
            continue

        sniper = evaluate_sniper_window(
            sym,
            alt_history,
            btc_history,
            window_seconds=window_seconds,
        )
        sniper["candleRegime"] = btc_regime

        for fallback_side in ("LONG", "SHORT"):
            attempted += 1
            signal = await record_signal_from_gate(sym, fallback_side, sniper, config)
            was_recorded = bool(signal.get("recorded"))
            recorded += 1 if was_recorded else 0
            analyses.append(_compact_analysis(sym, fallback_side, sniper, was_recorded))

    log.info(
        "Shadow sampler cycle=%d done: attempted=%d recorded=%d skipped=%d",
        cycle_num, attempted, recorded, skipped_no_data,
    )

    _sampler_state.update({
        "enabled": _env_bool("SHADOW_SAMPLER_ENABLED", True),
        "running": True,
        "lastRunAt": time.time(),
        "lastError": None,
        "cycles": cycle_num,
        "attempted": int(_sampler_state["attempted"]) + attempted,
        "recorded": int(_sampler_state["recorded"]) + recorded,
        "skippedNoData": int(_sampler_state["skippedNoData"]) + skipped_no_data,
        "lastAnalyses": analyses[:40],
    })

    return {
        "attempted": attempted,
        "recorded": recorded,
        "skippedNoData": skipped_no_data,
        "analyses": analyses,
    }


async def run_shadow_signal_sampler(engine: FeatureEngine, interval_seconds: int = 60) -> None:
    enabled = _env_bool("SHADOW_SAMPLER_ENABLED", True)
    _sampler_state.update({
        "enabled": enabled,
        "running": enabled,
        "intervalSeconds": interval_seconds,
    })
    if not enabled:
        return

    while True:
        try:
            await sample_shadow_signals_once(engine)
        except asyncio.CancelledError:
            _sampler_state["running"] = False
            raise
        except Exception as exc:
            _sampler_state["lastError"] = f"{type(exc).__name__}: {exc}"

        await asyncio.sleep(interval_seconds)
