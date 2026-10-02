#!/usr/bin/env python3
"""Reproducible thumbnail render and scan-pressure benchmark.

The RAW fixture is deliberately supplied by the caller because camera files are
large and carry their own redistribution terms. Example:

    backend/.venv/bin/python scripts/benchmark_thumbnail_delivery.py \
        --raw /path/to/fixture.CR2

The script creates the other source classes and a synthetic scan tree in a
temporary directory, prints one JSON report, and exits non-zero when the
recorded scan-slowdown budget is exceeded.
"""

from __future__ import annotations

import argparse
import gc
import json
import os
import shutil
import statistics
import subprocess
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import psutil
from PIL import Image

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "backend"))

from app.api.routes.media import _render_thumbnail  # noqa: E402
from app.core.config import Config  # noqa: E402
from app.services.analysis_service import AnalysisService  # noqa: E402
from app.services.filesystem_service import FileSystemService  # noqa: E402

REQUESTED_EDGES = (160, 240, 900, 1200, 1400, 2048)


def _make_fixtures(root: Path, raw_source: Path) -> dict[str, Path]:
    fixtures = {
        "small_jpeg": root / "small.jpg",
        "large_jpeg": root / "large.jpg",
        "heic": root / "photo.heic",
        "raw": root / raw_source.name,
        "video_keyframe": root / "clip.mp4",
    }
    Image.new("RGB", (640, 480), (45, 120, 210)).save(
        fixtures["small_jpeg"], format="JPEG", quality=90
    )
    Image.effect_noise((6000, 4000), 48).convert("RGB").save(
        fixtures["large_jpeg"], format="JPEG", quality=90
    )
    try:
        import pillow_heif

        pillow_heif.register_heif_opener()
        Image.effect_noise((4032, 3024), 32).convert("RGB").save(
            fixtures["heic"], format="HEIF", quality=85
        )
    except Exception as exc:
        raise RuntimeError("pillow-heif could not create the HEIC fixture") from exc
    shutil.copy2(raw_source, fixtures["raw"])
    subprocess.run(
        [
            shutil.which("ffmpeg") or "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=1920x1080:rate=30",
            "-t",
            "2",
            "-pix_fmt",
            "yuv420p",
            "-y",
            str(fixtures["video_keyframe"]),
        ],
        check=True,
    )
    return fixtures


def _render_costs(fixtures: dict[str, Path], repeats: int) -> dict[str, Any]:
    report: dict[str, Any] = {}
    for source_class, path in fixtures.items():
        sizes: dict[str, Any] = {}
        for edge in REQUESTED_EDGES:
            samples = []
            output_bytes = 0
            for _ in range(repeats):
                started = time.perf_counter()
                data = _render_thumbnail(str(path), edge)
                samples.append((time.perf_counter() - started) * 1000)
                if data is None:
                    raise RuntimeError(f"{source_class} did not render at {edge}px")
                output_bytes = len(data)
            sizes[str(edge)] = {
                "median_ms": round(statistics.median(samples), 2),
                "max_ms": round(max(samples), 2),
                "output_bytes": output_bytes,
            }
        report[source_class] = {
            "source_bytes": path.stat().st_size,
            "sizes": sizes,
        }
    return report


def _make_scan_tree(root: Path, source: Path, count: int) -> None:
    for index in range(count):
        directory = root / f"{index // 1000:04d}"
        directory.mkdir(exist_ok=True)
        os.link(source, directory / f"{index:07d}.jpg")


def _sample_process(
    stop: threading.Event,
    peaks: dict[str, int],
) -> None:
    process = psutil.Process()
    while not stop.wait(0.01):
        peaks["rss_bytes"] = max(peaks["rss_bytes"], process.memory_info().rss)
        peaks["threads"] = max(peaks["threads"], process.num_threads())


def _scan_once(
    service: AnalysisService,
    config: Config,
    load_sources: list[Path],
    concurrency: int,
) -> dict[str, Any]:
    stop = threading.Event()
    peaks = {"rss_bytes": psutil.Process().memory_info().rss, "threads": 1}
    sampler = threading.Thread(target=_sample_process, args=(stop, peaks), daemon=True)
    renders = [0]

    def load(index: int) -> None:
        path = load_sources[index % len(load_sources)]
        while not stop.is_set():
            if _render_thumbnail(str(path), 240) is not None:
                renders[0] += 1

    sampler.start()
    started = time.perf_counter()
    if concurrency:
        with ThreadPoolExecutor(max_workers=concurrency) as pool:
            futures = [pool.submit(load, index) for index in range(concurrency)]
            result = service._analyse_sync(config)  # noqa: SLF001 - benchmark hot path
            stop.set()
            for future in futures:
                future.result()
    else:
        result = service._analyse_sync(config)  # noqa: SLF001 - benchmark hot path
        stop.set()
    elapsed_ms = (time.perf_counter() - started) * 1000
    sampler.join()
    if result["total_files"] <= 0:
        raise RuntimeError("synthetic scan found no files")
    return {
        "elapsed_ms": round(elapsed_ms, 2),
        "files": result["total_files"],
        "peak_rss_bytes": peaks["rss_bytes"],
        "peak_threads": peaks["threads"],
        "thumbnail_renders": renders[0],
    }


def _pressure(
    root: Path,
    fixtures: dict[str, Path],
    scan_files: int,
    rounds: int,
    concurrency: int,
    slowdown_budget_percent: float,
) -> dict[str, Any]:
    scan_root = root / "scan"
    destination = root / "destination"
    scan_root.mkdir()
    destination.mkdir()
    _make_scan_tree(scan_root, fixtures["small_jpeg"], scan_files)
    config = Config(source_directory=str(scan_root), target_directory=str(destination))
    service = AnalysisService(FileSystemService())

    # Prime filesystem metadata so the comparison measures contention, not a
    # first-walk cache penalty.
    service._analyse_sync(config)  # noqa: SLF001 - benchmark hot path
    gc.collect()
    alone = [_scan_once(service, config, [], 0) for _ in range(rounds)]
    loaded = [
        _scan_once(service, config, list(fixtures.values()), concurrency)
        for _ in range(rounds)
    ]
    alone_median = statistics.median(item["elapsed_ms"] for item in alone)
    loaded_median = statistics.median(item["elapsed_ms"] for item in loaded)
    slowdown = 100 * (loaded_median / alone_median - 1)
    return {
        "scan_files": scan_files,
        "rounds": rounds,
        "thumbnail_concurrency": concurrency,
        "scan_alone": alone,
        "scan_with_thumbnails": loaded,
        "median_alone_ms": round(alone_median, 2),
        "median_with_thumbnails_ms": round(loaded_median, 2),
        "slowdown_percent": round(slowdown, 2),
        "slowdown_budget_percent": slowdown_budget_percent,
        "within_budget": slowdown <= slowdown_budget_percent,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--raw", type=Path, required=True)
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--scan-files", type=int, default=20_000)
    parser.add_argument("--scan-rounds", type=int, default=3)
    parser.add_argument("--concurrency", type=int, default=6)
    parser.add_argument("--slowdown-budget-percent", type=float, default=50.0)
    args = parser.parse_args()
    if not args.raw.is_file():
        parser.error(f"RAW fixture does not exist: {args.raw}")

    with tempfile.TemporaryDirectory(
        prefix="media-sorter-thumbnail-benchmark-"
    ) as temp:
        fixtures = _make_fixtures(Path(temp), args.raw)
        report = {
            "requested_edges": REQUESTED_EDGES,
            "render_costs": _render_costs(fixtures, args.repeats),
            "scan_pressure": _pressure(
                Path(temp),
                fixtures,
                args.scan_files,
                args.scan_rounds,
                args.concurrency,
                args.slowdown_budget_percent,
            ),
        }
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if report["scan_pressure"]["within_budget"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
