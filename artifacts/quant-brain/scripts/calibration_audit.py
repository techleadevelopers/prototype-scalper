from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path

from core import knowledge_base as kb
from core.calibration_audit import run_calibration_audit


async def main() -> None:
    parser = argparse.ArgumentParser(description="Chronological probability calibration audit")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    await kb.init_db()
    report = run_calibration_audit(await kb.get_calibration_audit_rows())
    payload = json.dumps(report, indent=2, sort_keys=True)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(payload + "\n", encoding="utf-8")
    print(payload)


if __name__ == "__main__":
    asyncio.run(main())
