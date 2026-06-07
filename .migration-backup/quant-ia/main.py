"""Quant Brain process entrypoint.

Application lifecycle is owned by ``api.server`` so the same initialization
and shutdown path is used by local execution, Railway, and ASGI test clients.
"""

import logging
import os
import sys

import uvicorn

sys.path.insert(0, os.path.dirname(__file__))

from api.server import app


logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s [%(name)s] %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)

log = logging.getLogger("quant-brain")


def _read_port() -> int:
    raw_port = os.environ.get("PORT", "9000")
    try:
        port = int(raw_port)
    except ValueError as exc:
        raise RuntimeError(f"PORT must be an integer, received {raw_port!r}") from exc

    if not 1 <= port <= 65535:
        raise RuntimeError(f"PORT must be between 1 and 65535, received {port}")
    return port


def main() -> None:
    port = _read_port()
    log.info("Starting Quant Brain on 0.0.0.0:%s", port)
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=port,
        log_level=os.environ.get("LOG_LEVEL", "info").lower(),
        access_log=False,
        timeout_keep_alive=30,
    )


if __name__ == "__main__":
    main()
