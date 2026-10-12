"""The public AI evaluation fixtures stay well-formed and in the shipped vocabulary.

``scripts/evaluate_local_ai.py`` scores against these labels; a label that left
the bundled vocabulary would silently count as never found.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

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
