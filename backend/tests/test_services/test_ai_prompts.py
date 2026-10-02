"""Tests for the shared CLIP prompt helpers (ensembling + descriptions + pooling)."""

from __future__ import annotations

import numpy as np

from app.services.ai.prompts import (
    DESCRIPTIONS,
    TEMPLATES,
    category_prompts,
    pool_normalized,
)


def test_category_prompts_plain_name_is_templates_only() -> None:
    # A name with no known description gets just the templates.
    assert category_prompts("vacation") == [t.format("vacation") for t in TEMPLATES]


def test_category_prompts_enriches_known_topic() -> None:
    prompts = category_prompts("screenshots")
    # Templates on the bare name are still present…
    assert "a photo of screenshots" in prompts
    # …plus the enriched description (so CLIP sees a far stronger prompt).
    assert DESCRIPTIONS["screenshots"] in prompts
    assert len(prompts) == len(TEMPLATES) + 2


def test_category_prompts_is_case_insensitive_for_descriptions() -> None:
    assert DESCRIPTIONS["receipts"] in category_prompts("Receipts")


def test_pool_normalized_averages_and_normalises_per_group() -> None:
    # Group 0: two collinear vectors → unit vector along x.
    # Group 1: a single vector → just normalised.
    raw = np.asarray([[2.0, 0.0, 0.0], [4.0, 0.0, 0.0], [0.0, 3.0, 0.0]], dtype=np.float32)
    pooled = pool_normalized(raw, [2, 1])
    assert pooled.shape == (2, 3)
    np.testing.assert_allclose(pooled[0], [1.0, 0.0, 0.0], atol=1e-5)
    np.testing.assert_allclose(pooled[1], [0.0, 1.0, 0.0], atol=1e-5)
    # Every pooled row is a unit vector.
    np.testing.assert_allclose(np.linalg.norm(pooled, axis=1), [1.0, 1.0], atol=1e-5)
