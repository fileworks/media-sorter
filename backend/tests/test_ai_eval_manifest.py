"""The public AI evaluation fixtures stay well-formed and in the shipped vocabulary.

``scripts/evaluate_local_ai.py`` scores against these labels; a label that left
the bundled vocabulary would silently count as never found.
"""

from __future__ import annotations

import importlib.util
import json
import re
import sys
from pathlib import Path
from typing import Any

from app.core.concepts import bundled_labels

MANIFEST = Path(__file__).resolve().parents[2] / "scripts" / "ai-eval" / "commons-manifest.json"


def _images() -> list[dict[str, object]]:
    return list(json.loads(MANIFEST.read_text(encoding="utf-8"))["images"])


def test_every_fixture_is_pinned_licensed_and_attributed() -> None:
    images = _images()
    assert len(images) >= 200
    ids = [image["id"] for image in images]
    assert len(ids) == len(set(ids))
    for image in images:
        assert re.fullmatch(r"[0-9a-f]{64}", str(image["sha256"])), image["id"]
        assert str(image["url"]).startswith(
            ("https://upload.wikimedia.org/", "https://thumb.wikimedia.org/")
        ), image["id"]
        assert str(image["page"]).startswith("https://commons.wikimedia.org/"), image["id"]
        assert image["license"], image["id"]


def test_labels_and_categories_are_in_the_shipped_vocabulary() -> None:
    tags = set(bundled_labels("tag", "en"))
    categories = set(bundled_labels("category", "en"))
    for image in _images():
        for label in [*image["labels"], *image["acceptable"]]:  # type: ignore[misc]
            assert set(str(label).split("|")) <= tags, (image["id"], label)
        expected = [image["category"], *image["acceptable_categories"]]  # type: ignore[misc]
        assert {c for c in expected if c is not None} <= categories, image["id"]


def test_no_image_appears_twice_under_different_ids() -> None:
    # One Commons file listed twice put the same image in both halves (F1-006).
    images = _images()
    for key in ("sha256", "url", "page"):
        values = [image[key] for image in images]
        assert len(values) == len(set(values)), key


def test_every_fixture_has_a_frozen_split() -> None:
    images = _images()
    assert {image["split"] for image in images} == {"calibration", "held_out"}
    held_out = sum(1 for image in images if image["split"] == "held_out")
    assert abs(held_out - (len(images) - held_out)) <= 2


def _evaluator() -> Any:
    path = MANIFEST.parents[1] / "evaluate_local_ai.py"
    spec = importlib.util.spec_from_file_location("evaluate_local_ai", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    # Dataclasses resolve their module through sys.modules while executing.
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_a_failed_download_does_not_move_images_between_halves() -> None:
    evaluator = _evaluator()
    images = _images()
    complete = [image["id"] for image in evaluator.split(images, "held_out")]
    without_first = [image["id"] for image in evaluator.split(images[1:], "held_out")]

    assert without_first == [image_id for image_id in complete if image_id != images[0]["id"]]


def test_category_scores_name_each_population_and_denominator() -> None:
    score = _evaluator().CategoryScore()
    score.add("nature", [], "nature")
    score.add(None, [], None)

    row = score.row()

    assert row["expected_coverage"] == 1.0
    assert (row["assigned"], row["images"], row["assigned_share"]) == (1, 2, 0.5)
    assert row["expected_images"] == 1
