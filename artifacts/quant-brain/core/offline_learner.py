"""
offline_learner.py

Pipeline de Re-treinamento Autônomo 24h — Feedback Loop do Edge.

Lê o arquivo trigger_outcomes.jsonl escrito pelo backend Node.js
(gerado pelo exhaustionTriggerManager.ts, Sistema 3) e retroalimenta
o banco de dados do QB com os desfechos reais dos gatilhos:

  FILLED_AND_WON          → won=True  → reconcile_signal_outcome()
  FILLED_AND_STOPPED      → won=False → reconcile_signal_outcome()
  EXPIRED_UNFILLED        → won=False → reconcile_signal_outcome()
  PARTIAL_FILL_CANCELLED  → skip (sem desfecho PnL final definido)
  SECTOR_CASCADE_CANCELLED → skip (cancelamento de gestão, não de mercado)

Após processar >= OFFLINE_LEARNER_MIN_OUTCOMES_FOR_TRAIN novos outcomes,
dispara train_shadow_model() — o mesmo motor de treinamento incremental
que o endpoint /training/run já usa.

Arquitetura de Checkpoint:
  - Persiste último epoch processado em offline_learner_checkpoint.json
  - Garante idempotência: re-execuções não duplicam outcomes
  - Tolerante a falhas: processa parcialmente se a linha for malformada

Configuração via ENV:
  TRIGGER_OUTCOMES_PATH                — caminho do JSONL (default: ./trigger_outcomes.jsonl)
  OFFLINE_LEARNER_MIN_OUTCOMES_FOR_TRAIN — mínimo de novos outcomes para disparar treino (default: 20)
  OFFLINE_LEARNER_MIN_SAMPLES          — amostras mínimas para treino seguro (default: 100)
  OFFLINE_LEARNER_ENABLED              — habilita/desabilita (default: true)
  OFFLINE_LEARNER_CHECKPOINT_PATH      — caminho do checkpoint (default: data/offline_learner_checkpoint.json)
"""

from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path
from typing import Any

from core import knowledge_base as kb
from core.shadow_model import train_shadow_model

log = logging.getLogger("offline_learner")

DATA_DIR = Path(__file__).parent.parent / "data"

WINNING_TAGS = {"FILLED_AND_WON"}
LOSING_TAGS = {"FILLED_AND_STOPPED", "EXPIRED_UNFILLED"}
SKIP_TAGS = {"PARTIAL_FILL_CANCELLED", "SECTOR_CASCADE_CANCELLED"}

_learner_state: dict[str, Any] = {
    "enabled": True,
    "lastRunAt": 0.0,
    "lastError": None,
    "cycles": 0,
    "outcomesParsed": 0,
    "outcomesSkipped": 0,
    "outcomesRecorded": 0,
    "outcomesAlreadyProcessed": 0,
    "trainingsTriggered": 0,
    "lastTrainingResult": None,
    "checkpointTs": 0.0,
}


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


def _outcomes_path() -> Path:
    raw = os.environ.get("TRIGGER_OUTCOMES_PATH", "").strip()
    if raw:
        return Path(raw)
    # Fallback: tenta localizar relativamente ao diretório de dados padrão
    # Node.js escreve em TELEMETRY_DIR ?? "." — se não configurado, busca na raiz do projeto
    candidates = [
        Path("trigger_outcomes.jsonl"),
        Path("../trigger_outcomes.jsonl"),
        Path("../../trigger_outcomes.jsonl"),
        DATA_DIR / "trigger_outcomes.jsonl",
    ]
    for p in candidates:
        if p.exists():
            return p
    return Path("trigger_outcomes.jsonl")


def _checkpoint_path() -> Path:
    raw = os.environ.get("OFFLINE_LEARNER_CHECKPOINT_PATH", "").strip()
    if raw:
        return Path(raw)
    return DATA_DIR / "offline_learner_checkpoint.json"


def _load_checkpoint() -> float:
    try:
        cp = _checkpoint_path()
        if not cp.exists():
            return 0.0
        data = json.loads(cp.read_text(encoding="utf-8"))
        return float(data.get("lastProcessedTs", 0.0) or 0.0)
    except Exception as exc:
        log.warning("Offline learner checkpoint load failed: %s", exc)
        return 0.0


def _save_checkpoint(last_ts: float) -> None:
    try:
        cp = _checkpoint_path()
        cp.parent.mkdir(parents=True, exist_ok=True)
        tmp = cp.with_suffix(".json.tmp")
        tmp.write_text(
            json.dumps({"lastProcessedTs": last_ts, "savedAt": time.time()}, ensure_ascii=False),
            encoding="utf-8",
        )
        tmp.replace(cp)
        _learner_state["checkpointTs"] = last_ts
    except Exception as exc:
        log.warning("Offline learner checkpoint save failed: %s", exc)


def offline_learner_status() -> dict[str, Any]:
    return dict(_learner_state)


async def query_purified_samples_count() -> int:
    """
    Elevação 2: Conta amostras purificadas diretamente no banco de dados.

    "Purificadas" = sinais que:
      1. Passaram pelo gate (signal_outcomes.allowed = 1)
      2. Viraram trades reais (existem em trade_outcomes)
      3. Têm PnL registrado (pnl_usdt IS NOT NULL)

    Essa contagem é a matéria-prima limpa para o retreino do shadow model.
    Inclui um path secundário por setup_type = 'SNIPER_GRID_VALIDATED' para
    rastrear especificamente os ARM_TRIGGER_GRID que passaram pelo quality gate.
    """
    try:
        async with kb.connect(kb.DB_PATH) as db:
            cursor = await db.execute(
                """
                SELECT COUNT(*)
                FROM signal_outcomes s
                JOIN trade_outcomes t ON s.source_id = t.outcome_source_id
                WHERE s.allowed = 1
                  AND t.pnl_usdt IS NOT NULL
                """
            )
            row = await cursor.fetchone()
            total = int(row[0]) if row else 0

            cursor2 = await db.execute(
                """
                SELECT COUNT(*)
                FROM signal_outcomes s
                JOIN trade_outcomes t ON s.source_id = t.outcome_source_id
                WHERE s.setup_type = 'SNIPER_GRID_VALIDATED'
                  AND t.pnl_usdt IS NOT NULL
                """
            )
            row2 = await cursor2.fetchone()
            sniper_grid = int(row2[0]) if row2 else 0

        _learner_state["purifiedSamplesCount"] = total
        _learner_state["sniperGridValidatedCount"] = sniper_grid
        return total
    except Exception as exc:
        log.debug("query_purified_samples_count falhou: %s", exc)
        return int(_learner_state.get("purifiedSamplesCount") or 0)


def _read_outcomes_since(path: Path, since_ts: float) -> list[dict[str, Any]]:
    """Lê entradas do JSONL com ts > since_ts (checkpoint)."""
    entries: list[dict[str, Any]] = []
    try:
        if not path.exists():
            return entries
        with path.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                    if not isinstance(entry, dict):
                        continue
                    entry_ts = float(entry.get("ts", 0) or 0)
                    if entry_ts > since_ts:
                        entries.append(entry)
                except (json.JSONDecodeError, ValueError):
                    continue
    except Exception as exc:
        log.warning("Offline learner: failed to read outcomes file %s: %s", path, exc)
    return entries


async def perform_daily_recalibration() -> dict[str, Any]:
    """
    Job principal do offline learner — chamado pelo job_supervisor a cada 24h.

    1. Lê novos outcomes do trigger_outcomes.jsonl (apenas desde o último checkpoint)
    2. Para cada outcome com signalId, reconcilia no banco do QB
    3. Se acumulou >= MIN_OUTCOMES_FOR_TRAIN novos outcomes → dispara treinamento
    4. Salva checkpoint
    """
    if not _env_bool("OFFLINE_LEARNER_ENABLED", True):
        return {"skipped": True, "reason": "OFFLINE_LEARNER_ENABLED=false"}

    cycle = int(_learner_state["cycles"]) + 1
    _learner_state["cycles"] = cycle
    _learner_state["lastRunAt"] = time.time()
    _learner_state["lastError"] = None

    log.info("[offline_learner] cycle=%d iniciando re-calibração autônoma", cycle)

    outcomes_path = _outcomes_path()
    last_ts = _load_checkpoint()
    new_outcomes = _read_outcomes_since(outcomes_path, last_ts)

    if not new_outcomes:
        log.info("[offline_learner] cycle=%d nenhum outcome novo desde ts=%.0f", cycle, last_ts)
        return {"cycle": cycle, "newOutcomes": 0, "trainingTriggered": False}

    log.info("[offline_learner] cycle=%d processando %d novos outcomes", cycle, len(new_outcomes))

    recorded = 0
    skipped = 0
    already_done = 0
    new_max_ts = last_ts

    min_samples = _env_int("OFFLINE_LEARNER_MIN_SAMPLES", 100)
    min_for_train = _env_int("OFFLINE_LEARNER_MIN_OUTCOMES_FOR_TRAIN", 20)

    for entry in new_outcomes:
        tag = str(entry.get("tag", ""))
        signal_id = str(entry.get("signalId") or "").strip()
        entry_ts = float(entry.get("ts", 0) or 0)
        new_max_ts = max(new_max_ts, entry_ts)

        _learner_state["outcomesParsed"] = int(_learner_state.get("outcomesParsed", 0)) + 1

        if tag in SKIP_TAGS or not signal_id:
            skipped += 1
            _learner_state["outcomesSkipped"] = int(_learner_state.get("outcomesSkipped", 0)) + 1
            continue

        if tag not in WINNING_TAGS and tag not in LOSING_TAGS:
            skipped += 1
            _learner_state["outcomesSkipped"] = int(_learner_state.get("outcomesSkipped", 0)) + 1
            continue

        won = tag in WINNING_TAGS
        outcome_source_id = f"offline_learner:{entry.get('id', signal_id)}"

        try:
            did_record = await kb.reconcile_signal_outcome(
                signal_id=signal_id,
                outcome_source_id=outcome_source_id,
                won=won,
            )
            if did_record:
                recorded += 1
                _learner_state["outcomesRecorded"] = int(_learner_state.get("outcomesRecorded", 0)) + 1
                log.debug(
                    "[offline_learner] reconciliado signal_id=%s tag=%s won=%s",
                    signal_id, tag, won,
                )
            else:
                already_done += 1
                _learner_state["outcomesAlreadyProcessed"] = int(_learner_state.get("outcomesAlreadyProcessed", 0)) + 1
        except Exception as exc:
            log.warning(
                "[offline_learner] falha ao reconciliar signal_id=%s: %s",
                signal_id, exc,
            )
            skipped += 1

    # Salva checkpoint: mesmo que o treinamento falhe, não re-processa esses outcomes
    if new_max_ts > last_ts:
        _save_checkpoint(new_max_ts)

    log.info(
        "[offline_learner] cycle=%d outcomes: recorded=%d skipped=%d already_done=%d total_new=%d",
        cycle, recorded, skipped, already_done, len(new_outcomes),
    )

    training_result = None
    training_triggered = False

    # Dispara treinamento se acumulou novos outcomes suficientes
    if recorded >= min_for_train:
        log.info(
            "[offline_learner] cycle=%d %d novos outcomes → disparando train_shadow_model(min_samples=%d)",
            cycle, recorded, min_samples,
        )
        try:
            training_result = await train_shadow_model(min_samples=min_samples)
            training_triggered = True
            _learner_state["trainingsTriggered"] = int(_learner_state.get("trainingsTriggered", 0)) + 1
            _learner_state["lastTrainingResult"] = {
                "at": time.time(),
                "savedModel": training_result.get("savedModel", False),
                "samples": training_result.get("samples"),
                "brier": training_result.get("brier"),
                "profitabilityVerified": training_result.get("profitabilityVerified"),
            }
            log.info(
                "[offline_learner] treinamento concluído: savedModel=%s samples=%s",
                training_result.get("savedModel"),
                training_result.get("samples"),
            )
        except Exception as exc:
            log.error("[offline_learner] train_shadow_model falhou: %s", exc)
            _learner_state["lastError"] = f"{type(exc).__name__}: {exc}"
    else:
        log.info(
            "[offline_learner] cycle=%d apenas %d novos outcomes (< %d mínimo) — treino adiado",
            cycle, recorded, min_for_train,
        )

    return {
        "cycle": cycle,
        "newOutcomes": len(new_outcomes),
        "recorded": recorded,
        "skipped": skipped,
        "alreadyDone": already_done,
        "trainingTriggered": training_triggered,
        "trainingResult": training_result,
    }
