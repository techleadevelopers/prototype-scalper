from __future__ import annotations

import asyncio
import os
from concurrent.futures import ThreadPoolExecutor
from functools import partial
from typing import Any, Callable, TypeVar


T = TypeVar("T")
_CPU_WORKERS = max(1, int(os.environ.get("QB_BLOCKING_WORKERS", "2")))
_EDGE_WORKERS = max(1, int(os.environ.get("QB_EDGE_WORKERS", "2")))
_CPU_EXECUTOR = ThreadPoolExecutor(max_workers=_CPU_WORKERS, thread_name_prefix="qb-cpu")
_EDGE_EXECUTOR = ThreadPoolExecutor(max_workers=_EDGE_WORKERS, thread_name_prefix="qb-edge")
_TRAINING_EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix="qb-train")
_CPU_SEMAPHORE = asyncio.Semaphore(_CPU_WORKERS)
_EDGE_SEMAPHORE = asyncio.Semaphore(_EDGE_WORKERS)


async def run_blocking(fn: Callable[..., T], *args: Any, **kwargs: Any) -> T:
    """Run CPU-bound sync work outside the main asyncio event loop."""
    loop = asyncio.get_running_loop()
    async with _CPU_SEMAPHORE:
        return await loop.run_in_executor(_CPU_EXECUTOR, partial(fn, *args, **kwargs))


async def run_edge_blocking(fn: Callable[..., T], *args: Any, **kwargs: Any) -> T:
    """Run latency-sensitive edge-gate sync work without competing with background jobs."""
    loop = asyncio.get_running_loop()
    async with _EDGE_SEMAPHORE:
        return await loop.run_in_executor(_EDGE_EXECUTOR, partial(fn, *args, **kwargs))


async def run_training_blocking(fn: Callable[..., T], *args: Any, **kwargs: Any) -> T:
    """Run long ML training in a dedicated single-worker executor."""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(_TRAINING_EXECUTOR, partial(fn, *args, **kwargs))
