"""Tests for RuleEngineService — rule evaluation and tag assignment."""

from __future__ import annotations

from pathlib import Path

import pytest

from app.core.config import Config
from app.services.rule_engine_service import RuleEngineService


def _engine(rules: list, rules_enabled: bool = True) -> RuleEngineService:
    cfg = Config(rules_enabled=rules_enabled, rules=rules)
    return RuleEngineService(config=cfg)


# ------------------------------------------------------------------ #
# Disabled engine                                                        #
# ------------------------------------------------------------------ #


def test_disabled_engine_returns_empty_tags(tmp_path: Path) -> None:
    f = tmp_path / "photo.raw"
    f.touch()
    engine = _engine(
        rules=[{"id": "r1", "condition": {"type": "extension", "value": "raw"}, "tag": "RAW"}],
        rules_enabled=False,
    )
    assert engine.evaluate(f) == []


# ------------------------------------------------------------------ #
# Extension rule                                                         #
# ------------------------------------------------------------------ #


def test_extension_rule_matches(tmp_path: Path) -> None:
    f = tmp_path / "photo.jpg"
    f.touch()
    engine = _engine(
        rules=[{"id": "r1", "condition": {"type": "extension", "value": "jpg"}, "tag": "JPEG"}]
    )
    assert "JPEG" in engine.evaluate(f)


def test_extension_rule_case_insensitive(tmp_path: Path) -> None:
    f = tmp_path / "photo.JPG"
    f.touch()
    engine = _engine(
        rules=[{"id": "r1", "condition": {"type": "extension", "value": "jpg"}, "tag": "JPEG"}]
    )
    assert "JPEG" in engine.evaluate(f)


def test_extension_rule_no_match(tmp_path: Path) -> None:
    f = tmp_path / "video.mp4"
    f.touch()
    engine = _engine(
        rules=[{"id": "r1", "condition": {"type": "extension", "value": "raw"}, "tag": "RAW"}]
    )
    assert engine.evaluate(f) == []


# ------------------------------------------------------------------ #
# Filename-contains rule                                                 #
# ------------------------------------------------------------------ #


def test_filename_contains_matches(tmp_path: Path) -> None:
    f = tmp_path / "IMG_20240101_vacation.jpg"
    f.touch()
    engine = _engine(
        rules=[
            {
                "id": "r1",
                "condition": {"type": "filename_contains", "value": "vacation"},
                "tag": "VACATION",
            }
        ]
    )
    assert "VACATION" in engine.evaluate(f)


def test_filename_contains_no_match(tmp_path: Path) -> None:
    f = tmp_path / "birthday_party.jpg"
    f.touch()
    engine = _engine(
        rules=[
            {
                "id": "r1",
                "condition": {"type": "filename_contains", "value": "vacation"},
                "tag": "VACATION",
            }
        ]
    )
    assert engine.evaluate(f) == []


# ------------------------------------------------------------------ #
# Size rule                                                              #
# ------------------------------------------------------------------ #


def test_size_rule_gt_matches_large_file(tmp_path: Path) -> None:
    f = tmp_path / "large.jpg"
    f.write_bytes(b"x" * (5 * 1024 * 1024))  # 5 MB
    engine = _engine(
        rules=[
            {
                "id": "r1",
                "condition": {"type": "size", "operator": "gt", "value": 1024 * 1024},
                "tag": "LARGE",
            }
        ]
    )
    assert "LARGE" in engine.evaluate(f)


def test_size_rule_lt_matches_small_file(tmp_path: Path) -> None:
    f = tmp_path / "thumb.jpg"
    f.write_bytes(b"x" * 100)
    engine = _engine(
        rules=[
            {
                "id": "r1",
                "condition": {"type": "size", "operator": "lt", "value": 1024},
                "tag": "TINY",
            }
        ]
    )
    assert "TINY" in engine.evaluate(f)


def test_size_rule_gt_no_match_for_small_file(tmp_path: Path) -> None:
    f = tmp_path / "small.jpg"
    f.write_bytes(b"x" * 100)
    engine = _engine(
        rules=[
            {
                "id": "r1",
                "condition": {"type": "size", "operator": "gt", "value": 1024 * 1024},
                "tag": "LARGE",
            }
        ]
    )
    assert engine.evaluate(f) == []


# ------------------------------------------------------------------ #
# Resolution rule                                                        #
# ------------------------------------------------------------------ #


def test_resolution_rule_matches_large_image(tmp_path: Path) -> None:
    PIL_Image = pytest.importorskip("PIL.Image")
    f = tmp_path / "big.jpg"
    PIL_Image.new("RGB", (4000, 3000)).save(f, format="JPEG")

    engine = _engine(
        rules=[
            {
                "id": "r1",
                "condition": {"type": "resolution", "operator": "gt", "value": "1920x1080"},
                "tag": "HD_PLUS",
            }
        ]
    )
    assert "HD_PLUS" in engine.evaluate(f)


def test_resolution_rule_no_match_for_small_image(tmp_path: Path) -> None:
    PIL_Image = pytest.importorskip("PIL.Image")
    f = tmp_path / "small.jpg"
    PIL_Image.new("RGB", (100, 100)).save(f, format="JPEG")

    engine = _engine(
        rules=[
            {
                "id": "r1",
                "condition": {"type": "resolution", "operator": "gt", "value": "1920x1080"},
                "tag": "HD_PLUS",
            }
        ]
    )
    assert engine.evaluate(f) == []


# ------------------------------------------------------------------ #
# Multiple rules                                                         #
# ------------------------------------------------------------------ #


def test_multiple_rules_can_produce_multiple_tags(tmp_path: Path) -> None:
    f = tmp_path / "raw_photo.raw"
    f.write_bytes(b"x" * (10 * 1024 * 1024))  # 10 MB raw file
    engine = _engine(
        rules=[
            {
                "id": "r1",
                "condition": {"type": "extension", "value": "raw"},
                "tag": "RAW",
            },
            {
                "id": "r2",
                "condition": {"type": "size", "operator": "gt", "value": 1024 * 1024},
                "tag": "LARGE",
            },
        ]
    )
    tags = engine.evaluate(f)
    assert "RAW" in tags
    assert "LARGE" in tags


def test_rules_with_empty_tag_are_skipped(tmp_path: Path) -> None:
    f = tmp_path / "photo.jpg"
    f.touch()
    engine = _engine(
        rules=[{"id": "r1", "condition": {"type": "extension", "value": "jpg"}, "tag": ""}]
    )
    assert engine.evaluate(f) == []


def test_broken_rule_does_not_crash_engine(tmp_path: Path) -> None:
    f = tmp_path / "photo.jpg"
    f.touch()
    engine = _engine(
        rules=[
            # Missing condition entirely
            {"id": "r_bad", "tag": "OOPS"},
            # Valid rule that should still run
            {"id": "r_good", "condition": {"type": "extension", "value": "jpg"}, "tag": "JPEG"},
        ]
    )
    tags = engine.evaluate(f)
    assert "JPEG" in tags


# ------------------------------------------------------------------ #
# Unknown condition type                                                 #
# ------------------------------------------------------------------ #


def test_unknown_condition_type_returns_no_tag(tmp_path: Path) -> None:
    f = tmp_path / "photo.jpg"
    f.touch()
    engine = _engine(
        rules=[
            {
                "id": "r1",
                "condition": {"type": "nonexistent_type", "value": "foo"},
                "tag": "NOPE",
            }
        ]
    )
    assert engine.evaluate(f) == []


# ------------------------------------------------------------------ #
# _compare — gte / lte / eq operators (lines 90-94)                   #
# ------------------------------------------------------------------ #


def test_compare_gte_matches_equal_value(tmp_path: Path) -> None:
    f = tmp_path / "file.bin"
    f.write_bytes(b"x" * 1000)
    engine = _engine(
        rules=[
            {
                "id": "r1",
                "condition": {"type": "size", "operator": "gte", "value": 1000},
                "tag": "GTE",
            }
        ]
    )
    assert "GTE" in engine.evaluate(f)


def test_compare_gte_matches_greater_value(tmp_path: Path) -> None:
    f = tmp_path / "file.bin"
    f.write_bytes(b"x" * 2000)
    engine = _engine(
        rules=[
            {
                "id": "r1",
                "condition": {"type": "size", "operator": "gte", "value": 1000},
                "tag": "GTE",
            }
        ]
    )
    assert "GTE" in engine.evaluate(f)


def test_compare_lte_matches_equal_value(tmp_path: Path) -> None:
    f = tmp_path / "file.bin"
    f.write_bytes(b"x" * 100)
    engine = _engine(
        rules=[
            {
                "id": "r1",
                "condition": {"type": "size", "operator": "lte", "value": 100},
                "tag": "LTE",
            }
        ]
    )
    assert "LTE" in engine.evaluate(f)


def test_compare_lte_matches_smaller_value(tmp_path: Path) -> None:
    f = tmp_path / "file.bin"
    f.write_bytes(b"x" * 50)
    engine = _engine(
        rules=[
            {
                "id": "r1",
                "condition": {"type": "size", "operator": "lte", "value": 100},
                "tag": "LTE",
            }
        ]
    )
    assert "LTE" in engine.evaluate(f)


def test_compare_eq_operator(tmp_path: Path) -> None:
    f = tmp_path / "file.bin"
    f.write_bytes(b"x" * 512)
    engine = _engine(
        rules=[
            {"id": "r1", "condition": {"type": "size", "operator": "eq", "value": 512}, "tag": "EQ"}
        ]
    )
    assert "EQ" in engine.evaluate(f)


# ------------------------------------------------------------------ #
# Size rule — exception path (lines 76-77)                            #
# ------------------------------------------------------------------ #


def test_size_rule_returns_false_for_nonexistent_file(tmp_path: Path) -> None:
    """Size rule on a missing file must silently return no tags."""
    f = tmp_path / "ghost.bin"
    # deliberately do NOT create the file
    engine = _engine(
        rules=[
            {"id": "r1", "condition": {"type": "size", "operator": "gt", "value": 0}, "tag": "ANY"}
        ]
    )
    assert engine.evaluate(f) == []


# ------------------------------------------------------------------ #
# Resolution rule — exception path (lines 108-109)                    #
# ------------------------------------------------------------------ #


def test_resolution_rule_non_image_returns_no_tag(tmp_path: Path) -> None:
    """Resolution rule on a non-image file must not crash."""
    f = tmp_path / "document.txt"
    f.write_text("hello")
    engine = _engine(
        rules=[
            {
                "id": "r1",
                "condition": {"type": "resolution", "operator": "gt", "value": "1x1"},
                "tag": "R",
            }
        ]
    )
    assert engine.evaluate(f) == []


# ------------------------------------------------------------------ #
# evaluate warning path (lines 25-26) — exception in _matches         #
# ------------------------------------------------------------------ #


def test_evaluate_warns_on_broken_rule_but_continues(tmp_path: Path) -> None:
    """A rule that raises inside _matches must log a warning and not crash."""

    f = tmp_path / "photo.jpg"
    f.touch()

    cfg = Config(
        rules_enabled=True,
        rules=[
            # This rule intentionally causes _matches to raise (missing 'condition' key)
            {
                "id": "bad",
                "condition": {"type": "size", "operator": "gt", "value": "not_a_number"},
                "tag": "OOPS",
            },
            {"id": "good", "condition": {"type": "extension", "value": "jpg"}, "tag": "JPEG"},
        ],
    )
    engine = RuleEngineService(config=cfg)
    tags = engine.evaluate(f)
    # The broken rule produces no tag, but the good one still fires
    assert "JPEG" in tags
    assert "OOPS" not in tags
