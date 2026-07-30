#!/usr/bin/env python3
"""Measure cache-hint memory/throughput and destructive full-hash throughput."""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
import time
import tracemalloc
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

from app.core.catalog_schema import fingerprint  # noqa: E402
from app.services.verified_transfer import revalidate_sha256  # noqa: E402

DEFAULT_COUNTS = (100_000, 500_000, 2_000_000)
MIN_HINTS_PER_SECOND = 100_000
MAX_HINT_PEAK_BYTES = 2 * 1024 * 1024
MIN_HASH_MIB_PER_SECOND = 20.0


def benchmark_hints(count: int) -> dict[str, Any]:
    tracemalloc.start()
    started = time.perf_counter()
    checksum = 0
    try:
        for index in range(count):
            value = fingerprint(
                size_bytes=1_000 + index % 997,
                mtime_ns=1_700_000_000_000_000_000 + index,
                ctime_ns=1_700_000_000_000_000_100 + index,
                file_identity=str(index),
                sample_sha256=None,
            )
            checksum ^= len(value)
        elapsed = max(time.perf_counter() - started, 1e-9)
        _current, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    rate = count / elapsed
    return {
        "records": count,
        "elapsed_seconds": round(elapsed, 3),
        "records_per_second": round(rate),
        "peak_bytes": peak,
        "stream_checksum": checksum,
        "within_budget": rate >= MIN_HINTS_PER_SECOND and peak <= MAX_HINT_PEAK_BYTES,
    }


def benchmark_full_hash(size_mib: int) -> dict[str, Any]:
    total_bytes = size_mib * 1024 * 1024
    with tempfile.TemporaryDirectory(prefix="mediasort-identity-benchmark-") as temporary:
        source = Path(temporary) / "source.bin"
        block = b"media-sorter-identity\n" * 4096
        with source.open("wb") as stream:
            remaining = total_bytes
            while remaining:
                chunk = block[:remaining]
                stream.write(chunk)
                remaining -= len(chunk)
        progress: list[int] = []
        started = time.perf_counter()
        _digest, measured = revalidate_sha256(
            source,
            on_progress=lambda done, _total: progress.append(done),
        )
        elapsed = max(time.perf_counter() - started, 1e-9)
    rate = measured / (1024 * 1024) / elapsed
    return {
        "bytes": measured,
        "elapsed_seconds": round(elapsed, 3),
        "mib_per_second": round(rate, 1),
        "progress_events": len(progress),
        "progress_complete": bool(progress and progress[-1] == measured),
        "within_budget": rate >= MIN_HASH_MIB_PER_SECOND,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--counts", nargs="+", type=int, default=list(DEFAULT_COUNTS))
    parser.add_argument("--hash-size-mib", type=int, default=64)
    args = parser.parse_args()
    if any(count < 1 for count in args.counts) or args.hash_size_mib < 1:
        parser.error("counts and hash size must be positive")
    report = {
        "budgets": {
            "minimum_hint_records_per_second": MIN_HINTS_PER_SECOND,
            "maximum_hint_peak_bytes": MAX_HINT_PEAK_BYTES,
            "minimum_full_hash_mib_per_second": MIN_HASH_MIB_PER_SECOND,
        },
        "cache_hints": [benchmark_hints(count) for count in args.counts],
        "destructive_full_hash": benchmark_full_hash(args.hash_size_mib),
    }
    print(json.dumps(report, indent=2, sort_keys=True))
    within_budget = all(result["within_budget"] for result in report["cache_hints"])
    within_budget = within_budget and report["destructive_full_hash"]["within_budget"]
    return 0 if within_budget else 1


if __name__ == "__main__":
    raise SystemExit(main())
