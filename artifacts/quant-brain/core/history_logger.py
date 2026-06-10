"""
history_logger.py

Filtro de Qualidade Sniper — persiste snapshots de sinais ARM_TRIGGER puros.

Chamado pelo edge_gate.py somente quando decision == "ARM_TRIGGER" e os 3
preços de geometria (triggerPrice / targetPrice / stopPrice) são válidos.

Motivo: o `trigger_outcomes.jsonl` registra DESFECHOS (o que aconteceu após
a execução, escrito pelo Node.js). Este arquivo registra SNAPSHOTS (o que o
QB viu e decidiu armar), com as features brutas que serão usadas pelo
offline_learner para treinar o modelo. Datasets separados → zero contaminação
de labels com features pós-evento.

Arquitetura de escrita:
  - Fila em memória + thread background: nunca bloqueia o event loop do FastAPI
  - Escrita atômica via arquivo .tmp → rename: sem corrupção em crash
  - Rotação automática quando o arquivo ultrapassa MAX_LINES (padrão: 100 000)

Configuração via ENV:
  SIGNAL_SNAPSHOTS_PATH   — caminho do JSONL (default: ./data/signal_snapshots.jsonl)
  SIGNAL_SNAPSHOTS_ENABLED — habilita/desabilita (default: true)
  SIGNAL_SNAPSHOTS_MAX_LINES — máximo de linhas antes de rotacionar (default: 100000)
"""

from __future__ import annotations

import json
import logging
import os
import queue
import threading
import time
from pathlib import Path
from typing import Any

log = logging.getLogger("history_logger")

_ENABLED = os.environ.get("SIGNAL_SNAPSHOTS_ENABLED", "true").strip().lower() not in {"0", "false", "no", "off"}
_MAX_LINES = max(1_000, int(os.environ.get("SIGNAL_SNAPSHOTS_MAX_LINES", "100000")))

_write_queue: queue.Queue[str] = queue.Queue(maxsize=2_000)
_writer_thread: threading.Thread | None = None
_lock = threading.Lock()


def _snapshots_path() -> Path:
    raw = os.environ.get("SIGNAL_SNAPSHOTS_PATH", "").strip()
    if raw:
        return Path(raw)
    base = Path(__file__).parent.parent / "data"
    base.mkdir(parents=True, exist_ok=True)
    return base / "signal_snapshots.jsonl"


def _rotate_if_needed(path: Path) -> None:
    try:
        if not path.exists():
            return
        content = path.read_text(encoding="utf-8")
        lines = [l for l in content.splitlines() if l.strip()]
        if len(lines) <= _MAX_LINES:
            return
        keep = lines[-(len(lines) // 2):]
        tmp = path.with_suffix(".jsonl.tmp")
        tmp.write_text("\n".join(keep) + "\n", encoding="utf-8")
        tmp.replace(path)
    except Exception as exc:
        log.warning("[history_logger] rotation failed: %s", exc)


def _writer_loop() -> None:
    path = _snapshots_path()
    batch: list[str] = []
    last_flush = time.monotonic()

    while True:
        try:
            try:
                line = _write_queue.get(timeout=0.5)
                if line is None:
                    break
                batch.append(line)
            except queue.Empty:
                pass

            now = time.monotonic()
            if batch and (len(batch) >= 20 or (now - last_flush) >= 1.0):
                try:
                    path.parent.mkdir(parents=True, exist_ok=True)
                    with path.open("a", encoding="utf-8") as f:
                        f.write("\n".join(batch) + "\n")
                    if len(batch) >= 100:
                        _rotate_if_needed(path)
                    last_flush = now
                    batch.clear()
                except Exception as exc:
                    log.warning("[history_logger] write failed: %s", exc)
                    batch.clear()
        except Exception:
            batch.clear()


def _ensure_writer() -> None:
    global _writer_thread
    with _lock:
        if _writer_thread is None or not _writer_thread.is_alive():
            _writer_thread = threading.Thread(
                target=_writer_loop,
                name="history_logger_writer",
                daemon=True,
            )
            _writer_thread.start()


def log_arm_trigger_snapshot(response: dict[str, Any]) -> None:
    """
    Filtra e persiste o snapshot de um sinal ARM_TRIGGER.

    Chamado pelo edge_gate.py imediatamente antes do return, quando
    decision == "ARM_TRIGGER". Descarta silenciosamente qualquer sinal que:
      - Não seja ARM_TRIGGER
      - Esteja com geometria incompleta (algum dos 3 preços ausente/zero)
      - SIGNAL_SNAPSHOTS_ENABLED=false

    O snapshot persistido contém exclusivamente dados ANTERIORES à execução:
    features multiframe, geometria, probabilidade, metadados do sinal.
    Nunca contém o outcome (WON/STOPPED/EXPIRED) — este é escrito pelo Node.js.
    """
    if not _ENABLED:
        return

    if response.get("decision") not in ("ARM_TRIGGER", "ARM_TRIGGER_GRID"):
        return

    geometry = response.get("geometry") or {}
    trigger_px = geometry.get("triggerPrice")
    target_px = geometry.get("targetPrice")
    stop_px = geometry.get("stopPrice")

    if not (trigger_px and target_px and stop_px):
        return

    metadata = response.get("metadata") or {}
    signal_id = metadata.get("signalId") or response.get("signalId") or ""
    if not signal_id:
        return

    snapshot: dict[str, Any] = {
        "ts": time.time(),
        "signalId": signal_id,
        "symbol": metadata.get("symbol") or response.get("symbol", ""),
        "sectorCluster": metadata.get("sectorCluster") or response.get("sectorCluster"),
        "geometry": geometry,
        "probabilityModel": response.get("probabilityModel") or {
            "confidence": response.get("confidence"),
            "edgeScore": response.get("edgeScore"),
            "expectedValue": response.get("expectedValue"),
            "kellyFraction": response.get("kellyFraction"),
        },
        "executionMetrics": response.get("executionMetrics") or {},
        "features": response.get("features") or {},
        "mode": response.get("mode"),
    }

    try:
        line = json.dumps(snapshot, ensure_ascii=False)
        _ensure_writer()
        _write_queue.put_nowait(line)
    except queue.Full:
        log.debug("[history_logger] write queue full — snapshot dropped for signal %s", signal_id)
    except Exception as exc:
        log.warning("[history_logger] snapshot enqueue failed: %s", exc)


def history_logger_status() -> dict[str, Any]:
    """Expõe estado do logger para o endpoint de diagnóstico do QB."""
    return {
        "enabled": _ENABLED,
        "queueDepth": _write_queue.qsize(),
        "writerAlive": _writer_thread is not None and _writer_thread.is_alive(),
        "snapshotsPath": str(_snapshots_path()),
        "maxLines": _MAX_LINES,
    }
