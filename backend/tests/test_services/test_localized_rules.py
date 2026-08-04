"""Focused contract tests for localized generated content and RuleSet v1."""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path
from typing import Any, cast

import numpy as np
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.core.concepts import CATALOG, bundled_labels
from app.core.config import Config, ConfigLoader, UnsupportedRuleSetVersionError
from app.core.rules import (
    FilenameContainsCondition,
    RouteRule,
    RuleSet,
    TagRule,
    append_contained_route,
    validate_relative_route,
)
from app.services.ai.base_tagger import (
    AzureVisionTagger,
    GoogleCloudVisionTagger,
    ImaggaTagger,
    LocalClipTagger,
)
from app.services.ai.encoder_protocol import VisionEncoder
from app.services.destination import build_dest_dir, reserve_destination
from app.services.rule_engine_service import RuleEngineService


def _tag_rule(
    rule_id: str,
    value: str,
    tag: str,
    *,
    priority: int = 0,
    enabled: bool = True,
) -> TagRule:
    return TagRule(
        id=rule_id,
        name=rule_id,
        enabled=enabled,
        priority=priority,
        condition=FilenameContainsCondition(type="filename_contains", value=value),
        tag=tag,
    )


def _route_rule(rule_id: str, value: str, route: str, priority: int = 0) -> RouteRule:
    return RouteRule(
        id=rule_id,
        name=rule_id,
        priority=priority,
        condition=FilenameContainsCondition(type="filename_contains", value=value),
        relative_folder=route,
    )


def test_language_defaults_and_bundled_provenance_are_prospective() -> None:
    english = Config.from_dict({})
    german = Config.from_dict({"language": "de"})
    assert english.language == "en"
    assert english.resolved_ai_tagging_labels() == bundled_labels("tag", "en")
    assert german.resolved_ai_tagging_labels() == bundled_labels("tag", "de")
    assert "screenshot" in english.resolved_ai_tagging_labels()
    assert "Bildschirmfoto" in german.resolved_ai_tagging_labels()


def test_custom_vocabulary_is_preserved_verbatim_across_locale_change() -> None:
    config = Config(ai_tagging_labels=["Family", "  exact spacing  "], language="de")
    assert config.ai_tagging_labels_provenance == "custom"
    assert config.resolved_ai_tagging_labels() == ["Family", "  exact spacing  "]
    config.language = "en"
    assert config.resolved_ai_tagging_labels() == ["Family", "  exact spacing  "]


def test_catalog_has_complete_unique_localized_defaults() -> None:
    assert CATALOG.concepts
    for concept in CATALOG.concepts:
        assert concept.id
        assert concept.labels["en"].strip()
        assert concept.labels["de"].strip()
        assert concept.prompts["en"].strip()
        assert concept.prompts["de"].strip()
    for kind in ("tag", "category"):
        for locale in ("en", "de"):
            labels = bundled_labels(kind, locale)
            assert len(labels) == len({label.casefold() for label in labels})


def test_unsupported_rule_version_and_generic_actions_are_rejected() -> None:
    with pytest.raises(ValidationError):
        RuleSet.model_validate({"version": 2, "tag_rules": [], "route_rules": []})
    with pytest.raises(ValidationError):
        RuleSet.model_validate(
            {
                "version": 1,
                "tag_rules": [
                    {
                        "id": "bad",
                        "name": "bad",
                        "enabled": True,
                        "priority": 0,
                        "condition": {"type": "extension", "value": "jpg"},
                        "tag": "photo",
                        "actions": [{"type": "route", "value": "../outside"}],
                    }
                ],
                "route_rules": [],
            }
        )


def test_config_api_rejections_include_localizable_issues(client: TestClient) -> None:
    for payload, expected_field in [
        ({"language": "fr"}, "language"),
        ({"rule_set": {"version": 2, "tag_rules": [], "route_rules": []}}, "rule_set"),
        ({"rules": []}, "rules"),
    ]:
        response = client.post("/api/config", json=payload)
        assert response.status_code == 422
        issue = response.json()["details"]["issues"][0]
        assert issue["field"] == expected_field
        assert issue["message_key"].startswith("config.update.")


def test_loader_does_not_rewrite_unsupported_rule_version(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("MEDIASORT_CONFIG_DIR", str(tmp_path))
    raw = {"rule_set": {"version": 9, "tag_rules": [], "route_rules": []}}
    path = tmp_path / "config.json"
    path.write_text(json.dumps(raw), encoding="utf-8")
    with pytest.raises(UnsupportedRuleSetVersionError):
        ConfigLoader().load()
    assert json.loads(path.read_text(encoding="utf-8")) == raw


def test_legacy_rules_migrate_with_backup_order_and_warnings(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("MEDIASORT_CONFIG_DIR", str(tmp_path))
    config_file = tmp_path / "config.json"
    legacy = {
        "$schema": "mediasort-config-v1",
        "rules": [
            {
                "id": "jpg",
                "name": "JPEG",
                "condition": {"type": "extension", "value": ".JPG"},
                "tag": "Photo",
            },
            {"id": "broken", "name": "Broken", "condition": {"type": "unknown"}, "tag": "X"},
            {
                "id": "screen",
                "name": "Screen",
                "condition": {"type": "filename", "value": "ScreenShot"},
                "tag": "Capture",
            },
        ],
        "ai_tagging_embed_in_files": False,
    }
    config_file.write_text(json.dumps(legacy), encoding="utf-8")

    loaded = ConfigLoader().load()

    assert [rule.id for rule in loaded.rule_set.tag_rules] == ["jpg", "screen"]
    assert [rule.priority for rule in loaded.rule_set.tag_rules] == [0, 1]
    assert loaded.rule_set.route_rules == []
    assert loaded.embed_tags_in_files is False
    assert loaded.migration_warnings and "legacy_skipped" in loaded.migration_warnings[0]
    backup = tmp_path / "config.pre-rules-v1.json"
    assert json.loads(backup.read_text(encoding="utf-8")) == legacy
    persisted = json.loads(config_file.read_text(encoding="utf-8"))
    assert "rules" not in persisted
    assert persisted["rule_set"]["version"] == 1


def test_rule_order_enablement_unicode_stems_and_first_route(tmp_path: Path) -> None:
    source = tmp_path / "Straße ScreenShot FINAL.JPG"
    source.write_bytes(b"x")
    config = Config(
        rule_set=RuleSet(
            tag_rules=[
                _tag_rule("late", "screenshot", "First spelling", priority=20),
                _tag_rule("early", "STRASSE", "Straße", priority=0),
                _tag_rule("disabled", "screenshot", "Ignored", priority=0, enabled=False),
                _tag_rule("dedupe", "screen", "STRASSE", priority=30),
            ],
            route_rules=[
                _route_rule("second", "screen", "second", priority=10),
                _route_rule("first", "SCREENSHOT", "screenshot", priority=0),
            ],
        )
    )
    result = RuleEngineService(config).evaluate_all(source)
    assert result.tags == ("Straße", "First spelling")
    assert result.matched_tag_rule_ids == ("early", "late", "dedupe")
    assert result.route == "screenshot"
    assert result.matched_route_rule_id == "first"

    config.rules_enabled = False
    assert RuleEngineService(config).evaluate_all(source).tags == ()


@pytest.mark.parametrize(
    "unsafe",
    [
        "",
        "../outside",
        "/absolute",
        "C:/drive",
        "//server/share",
        "one//two",
        "./one",
        "one/../two",
        "one\\two",
        "one/\x01two",
        "NUL",
        "COM1/file",
        "trailing.",
        "bad:name",
    ],
)
def test_unsafe_routes_are_rejected(unsafe: str) -> None:
    with pytest.raises(ValueError):
        validate_relative_route(unsafe)


def test_safe_nested_route_and_screenshot_date_path(tmp_path: Path) -> None:
    source_root = tmp_path / "source"
    target = tmp_path / "target"
    source = source_root / "Screenshot.JPG"
    source.parent.mkdir()
    config = Config(sort_criteria=["year", "month"])
    destination = build_dest_dir(
        source,
        date(2026, 7, 24),
        source_root,
        target,
        config,
        route_suffix="screenshot/mobile",
    )
    assert destination == target / "2026" / "07" / "screenshot" / "mobile"
    assert append_contained_route(target, "screenshots/mobile").is_relative_to(target)


def test_collision_reservation_covers_disk_and_same_batch(tmp_path: Path) -> None:
    destination = tmp_path / "2026" / "07" / "image.jpg"
    destination.parent.mkdir(parents=True)
    destination.write_bytes(b"existing")
    reserved: set[Path] = set()
    first = reserve_destination(destination, reserved)
    second = reserve_destination(destination, reserved)
    assert first.name == "image_001.jpg"
    assert second.name == "image_002.jpg"
    assert destination.read_bytes() == b"existing"


class _Response:
    def __init__(self, payload: dict[str, Any]) -> None:
        self.payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict[str, Any]:
        return self.payload


def test_cloud_providers_request_or_map_german(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[dict[str, Any]] = []

    def fake_post(_url: str, **kwargs: Any) -> _Response:
        calls.append(kwargs)
        if "files" in kwargs:
            return _Response({"result": {"tags": [{"tag": {"de": " Straße "}, "confidence": 95}]}})
        if "json" in kwargs:
            return _Response(
                {
                    "responses": [
                        {
                            "labelAnnotations": [
                                {"description": "Screenshot", "score": 0.9},
                                {"description": "Unmapped Thing", "score": 0.8},
                            ]
                        }
                    ]
                }
            )
        return _Response({"tagsResult": {"values": [{"name": " Straße ", "confidence": 0.9}]}})

    monkeypatch.setattr("app.services.ai.base_tagger.httpx.post", fake_post)
    image = pytest.importorskip("PIL.Image").new("RGB", (2, 2))

    assert AzureVisionTagger("https://azure", "key", locale="de").tag(image) == [("Straße", 0.9)]
    assert calls[-1]["params"]["language"] == "de"
    assert ImaggaTagger("key", "secret", locale="de").tag(image) == [("Straße", 0.95)]
    assert calls[-1]["data"]["language"] == "de"
    google = GoogleCloudVisionTagger("key", locale="de")
    assert google.tag(image) == [("Bildschirmfoto", 0.9)]
    assert google.warnings == ("provider.google.unmapped_label:Unmapped Thing",)


class _PromptCapture:
    model_id = "siglip2-base"
    tagger_slope = 10.0

    def __init__(self) -> None:
        self.texts: list[str] = []

    def embed_texts(self, texts: list[str]) -> np.ndarray[Any, Any]:
        self.texts = texts
        return np.ones((len(texts), 2), dtype=np.float32)

    def embed_image(self, _image: Any) -> np.ndarray[Any, Any]:
        return np.ones(2, dtype=np.float32)


def test_siglip_uses_german_prompts_but_emits_only_german() -> None:
    embedder = _PromptCapture()
    tagger = LocalClipTagger(
        ["Bildschirmfoto"],
        threshold=0,
        embedder=cast("VisionEncoder", embedder),
        locale="de",
        bundled=True,
    )
    image = pytest.importorskip("PIL.Image").new("RGB", (2, 2))
    assert tagger.tag(image)[0][0] == "Bildschirmfoto"
    assert any("Bildschirmfoto" in prompt for prompt in embedder.texts)
    assert not any("a photo of" in prompt for prompt in embedder.texts)
