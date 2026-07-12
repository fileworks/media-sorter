"""Integration tests for the config API routes."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.core.bootstrap import AppFactory
from app.core.config import Config


@pytest.fixture(scope="module")
def client() -> TestClient:
    app = AppFactory.create(config=Config.defaults())
    return TestClient(app)


# ------------------------------------------------------------------ #
# GET /api/config                                                        #
# ------------------------------------------------------------------ #


def test_get_config_returns_200(client: TestClient) -> None:
    response = client.get("/api/config")
    assert response.status_code == 200


def test_get_config_contains_expected_fields(client: TestClient) -> None:
    data = client.get("/api/config").json()
    assert "source_directory" in data
    assert "target_directory" in data
    assert "sort" in data
    assert "sort_criteria" in data
    assert "recursive_scan" in data
    assert "copy_instead_of_move" in data


def test_get_config_defaults(client: TestClient) -> None:
    data = client.get("/api/config").json()
    assert data["sort"] is True
    assert data["sort_criteria"] == ["year"]
    assert data["recursive_scan"] is True


def test_get_config_defaults_endpoint(client: TestClient) -> None:
    # The defaults endpoint is the source of truth for the UI's "deviates from
    # default" detection: it returns the factory defaults minus the path fields.
    data = client.get("/api/config/defaults").json()
    assert data["sort"] is True
    assert data["sort_criteria"] == ["year"]
    assert data["remove_duplicates"] is True
    assert data["ai_model_tier"] == "auto"
    # Path fields have no meaningful default and are excluded.
    assert "source_directory" not in data
    assert "target_directory" not in data


def test_get_config_defaults_unaffected_by_live_config(client: TestClient) -> None:
    # Changing the live config must not change what /defaults reports.
    client.post("/api/config", json={"sort": False, "remove_duplicates": False})
    try:
        defaults = client.get("/api/config/defaults").json()
        assert defaults["sort"] is True
        assert defaults["remove_duplicates"] is True
    finally:
        client.post("/api/config", json={"sort": True, "remove_duplicates": True})


def test_get_config_sections(client: TestClient) -> None:
    data = client.get("/api/config/sections").json()
    sections = data["sections"]
    ids = [s["id"] for s in sections]
    assert "essentials" in ids and "folders" in ids and "ai" in ids
    for section in sections:
        assert section["label"] and section["description"]
        assert isinstance(section["fields"], list) and section["fields"]


# ------------------------------------------------------------------ #
# POST /api/config                                                       #
# ------------------------------------------------------------------ #


def test_post_config_merges_update(client: TestClient) -> None:
    response = client.post("/api/config", json={"sort": False})
    assert response.status_code == 200
    assert response.json()["sort"] is False


def test_post_config_updates_sort_criteria(client: TestClient) -> None:
    response = client.post(
        "/api/config",
        json={"sort_criteria": ["year", "month"]},
    )
    assert response.status_code == 200
    assert response.json()["sort_criteria"] == ["year", "month"]


def test_post_config_updates_ai_tagging_fields(client: TestClient) -> None:
    response = client.post(
        "/api/config",
        json={
            "ai_tagging_enabled": True,
            "ai_tagging_provider": "imagga",
            "ai_tagging_labels": ["beach", "city"],
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["ai_tagging_enabled"] is True
    assert body["ai_tagging_provider"] == "imagga"
    assert body["ai_tagging_labels"] == ["beach", "city"]


def test_post_config_rebuilds_ai_tagging_service(client: TestClient) -> None:
    """Changing AI config must rebuild the cached AITaggingService (no stale provider)."""
    container = client.app.state.container  # type: ignore[attr-defined]
    # Force the lazy service to exist, then change the provider.
    _ = container.ai_tagging_service
    client.post("/api/config", json={"ai_tagging_enabled": True, "ai_tagging_provider": "local"})
    assert container._ai_tagging_service is not None
    assert container._ai_tagging_service._config.ai_tagging_provider == "local"


def test_post_config_tier_change_invalidates_encoder(client: TestClient) -> None:
    """Changing the AI model tier must drop the cached encoder + every service
    that captured it, so the new tier actually takes effect (rebuilt lazily)."""
    container = client.app.state.container  # type: ignore[attr-defined]
    # Simulate an already-built encoder + dependent services (sentinels — never
    # load a real model in a test).
    container._encoder = object()
    container._encoder_built = True
    container._ai_tagging_service = object()
    container._category_classifier_service = object()
    container._preview_service = object()
    container._sorting_service = object()

    client.post("/api/config", json={"ai_model_tier": "max"})

    assert container._encoder is None
    assert container._encoder_built is False
    assert container._ai_tagging_service is None
    assert container._category_classifier_service is None
    assert container._preview_service is None
    assert container._sorting_service is None
    client.post("/api/config", json={"ai_model_tier": "auto"})  # restore


def test_post_config_non_encoder_change_keeps_encoder(client: TestClient) -> None:
    container = client.app.state.container  # type: ignore[attr-defined]
    sentinel = object()
    container._encoder = sentinel
    container._encoder_built = True

    client.post("/api/config", json={"min_file_size_kb": 10})

    assert container._encoder is sentinel
    assert container._encoder_built is True
    client.post("/api/config", json={"min_file_size_kb": None})  # restore


def test_post_config_preserves_unmentioned_fields(client: TestClient) -> None:
    # First set source_directory
    client.post("/api/config", json={"source_directory": "/test/source"})
    # Then update something else — source_directory should be preserved
    response = client.post("/api/config", json={"sort": True})
    assert response.status_code == 200
    # The source_directory set in the previous call should still be there
    assert response.json()["source_directory"] == "/test/source"


def test_post_config_rejects_unknown_key(client: TestClient) -> None:
    """A typo'd / unknown field is a 422, not a silent no-op that drops it."""
    response = client.post("/api/config", json={"max_recursion_dpeth": 5})
    assert response.status_code == 422
    assert response.json()["code"] == "CONFIG_VALIDATION_ERROR"


def test_post_config_rejects_wrong_type(client: TestClient) -> None:
    """An incoercible value (string for a list field) is rejected at save time."""
    response = client.post("/api/config", json={"sort_criteria": "year"})
    assert response.status_code == 422


def test_post_config_rejects_invalid_literal(client: TestClient) -> None:
    """A Literal outside its allowed set is rejected before it can break a sort."""
    response = client.post("/api/config", json={"image_format": "bmp"})
    assert response.status_code == 422


def test_post_config_coerces_numeric_string(client: TestClient) -> None:
    """A JSON-coercible value is accepted and stored as the declared type."""
    response = client.post("/api/config", json={"max_recursion_depth": "5"})
    assert response.status_code == 200
    assert response.json()["max_recursion_depth"] == 5


def test_post_config_ignores_schema_marker(client: TestClient) -> None:
    """The ``$schema`` editor marker is tolerated, not treated as an unknown key."""
    response = client.post("/api/config", json={"$schema": "./schema.json", "sort": True})
    assert response.status_code == 200


# ------------------------------------------------------------------ #
# POST /api/config/validate                                              #
# ------------------------------------------------------------------ #


def test_validate_config_returns_errors_for_empty_paths(client: TestClient) -> None:
    # Reset directories to empty
    client.post(
        "/api/config",
        json={"source_directory": "", "target_directory": ""},
    )
    response = client.post("/api/config/validate")
    assert response.status_code == 200
    data = response.json()
    assert data["valid"] is False
    # Each issue names the field it belongs to so the UI can flag the exact
    # input and the section that owns it.
    fields = {e["field"] for e in data["errors"]}
    assert "source_directory" in fields
    assert "target_directory" in fields


def test_validate_config_flags_missing_source_folder(client: TestClient, tmp_path: Path) -> None:
    """A source path that isn't on disk is reported against source_directory with
    a user-facing message that quotes the offending path."""
    missing = tmp_path / "does-not-exist"
    client.post(
        "/api/config",
        json={"source_directory": str(missing), "target_directory": str(tmp_path / "target")},
    )
    data = client.post("/api/config/validate").json()
    assert data["valid"] is False
    issue = next(e for e in data["errors"] if e["field"] == "source_directory")
    assert "not found" in issue["message"].lower()
    assert str(missing) in issue["message"]


def test_validate_config_flags_same_source_and_destination(
    client: TestClient, tmp_path: Path
) -> None:
    """Sorting into the source itself is rejected against target_directory."""
    source = tmp_path / "shared"
    source.mkdir()
    client.post(
        "/api/config",
        json={"source_directory": str(source), "target_directory": str(source)},
    )
    data = client.post("/api/config/validate").json()
    assert data["valid"] is False
    assert any(
        e["field"] == "target_directory" and "different" in e["message"].lower()
        for e in data["errors"]
    )


def test_validate_config_returns_valid_when_paths_set(client: TestClient, tmp_path: Path) -> None:
    # Validation checks that the source exists on disk, so point it at a real
    # directory; the target does not need to exist yet.
    source = tmp_path / "source"
    source.mkdir()
    client.post(
        "/api/config",
        json={
            "source_directory": str(source),
            "target_directory": str(tmp_path / "target"),
        },
    )
    response = client.post("/api/config/validate")
    assert response.status_code == 200
    data = response.json()
    assert data["valid"] is True
    assert data["errors"] == []


def _post_valid_dirs(client: TestClient, tmp_path: Path, **extra: object) -> None:
    """POST a config with a real source dir plus any *extra* fields under test.

    The ``client`` fixture is module-scoped, so config state leaks between tests
    via the partial-merge save. This helper re-asserts a *clean, valid* baseline
    for every field a validation test might touch (size filters, categorize
    fields, …) so each test starts from a known-good config and only the *extra*
    fields under test diverge.
    """
    source = tmp_path / "source"
    source.mkdir()
    client.post(
        "/api/config",
        json={
            "source_directory": str(source),
            "target_directory": str(tmp_path / "target"),
            "rename": False,
            "rename_pattern": "TYPE_YYYY-MM-DD",
            "duplicate_perceptual_threshold": 95,
            "min_file_size_kb": None,
            "max_file_size_mb": None,
            "categorize_enabled": False,
            "categorize_categories": [],
            "categorize_confidence_threshold": 0.85,
            **extra,
        },
    )


def test_validate_config_warns_on_unknown_rename_token(client: TestClient, tmp_path: Path) -> None:
    """An unknown token is a *warning*, not an error: unknown text is treated as
    a literal by _apply_rename, so the config still saves and validates."""
    _post_valid_dirs(client, tmp_path, rename=True, rename_pattern="YYYY-MM-DD-FOO")
    data = client.post("/api/config/validate").json()
    assert data["valid"] is True
    assert data["errors"] == []
    assert any(w["field"] == "rename_pattern" and "FOO" in w["message"] for w in data["warnings"])


def test_validate_config_accepts_known_rename_pattern(client: TestClient, tmp_path: Path) -> None:
    _post_valid_dirs(client, tmp_path, rename=True, rename_pattern="TYPE_YYYY-MM-DD")
    data = client.post("/api/config/validate").json()
    assert data["valid"] is True
    assert data["errors"] == []


def test_validate_config_ignores_rename_pattern_when_rename_off(
    client: TestClient, tmp_path: Path
) -> None:
    # rename disabled → the (bad) pattern must not block validation.
    _post_valid_dirs(client, tmp_path, rename=False, rename_pattern="YYYY-MM-DD-FOO")
    data = client.post("/api/config/validate").json()
    assert data["valid"] is True


def test_validate_config_flags_negative_file_size(client: TestClient, tmp_path: Path) -> None:
    """A negative size filter is rejected even if it slips past the UI's min=0."""
    _post_valid_dirs(client, tmp_path, min_file_size_kb=-5, max_file_size_mb=-1)
    data = client.post("/api/config/validate").json()
    assert data["valid"] is False
    assert any(e["field"] == "min_file_size_kb" for e in data["errors"])
    assert any(e["field"] == "max_file_size_mb" for e in data["errors"])


def test_validate_config_flags_out_of_range_threshold(client: TestClient, tmp_path: Path) -> None:
    """Bug M6: a perceptual threshold outside 85–100 is rejected."""
    _post_valid_dirs(client, tmp_path, duplicate_perceptual_threshold=50)
    data = client.post("/api/config/validate").json()
    assert data["valid"] is False
    assert any(e["field"] == "duplicate_perceptual_threshold" for e in data["errors"])


def test_validate_config_accepts_valid_categories(client: TestClient, tmp_path: Path) -> None:
    _post_valid_dirs(
        client,
        tmp_path,
        categorize_enabled=True,
        categorize_categories=["food", "nature"],
        categorize_confidence_threshold=0.85,
    )
    data = client.post("/api/config/validate").json()
    assert data["valid"] is True
    assert data["errors"] == []


def test_validate_config_flags_unsafe_category(client: TestClient, tmp_path: Path) -> None:
    _post_valid_dirs(
        client, tmp_path, categorize_enabled=True, categorize_categories=["food", ".."]
    )
    data = client.post("/api/config/validate").json()
    assert data["valid"] is False
    assert any(
        e["field"] == "categorize_categories" and "unsafe" in e["message"].lower()
        for e in data["errors"]
    )


def test_validate_config_flags_out_of_range_categorize_threshold(
    client: TestClient, tmp_path: Path
) -> None:
    _post_valid_dirs(
        client,
        tmp_path,
        categorize_enabled=True,
        categorize_categories=["food"],
        categorize_confidence_threshold=0.2,  # below the 0.50 floor
    )
    data = client.post("/api/config/validate").json()
    assert data["valid"] is False
    assert any(e["field"] == "categorize_confidence_threshold" for e in data["errors"])


def test_validate_config_warns_on_empty_categories_when_enabled(
    client: TestClient, tmp_path: Path
) -> None:
    _post_valid_dirs(client, tmp_path, categorize_enabled=True, categorize_categories=[])
    data = client.post("/api/config/validate").json()
    assert data["valid"] is True  # empty is a warning, not an error
    assert any("_uncategorized" in w["message"] for w in data["warnings"])


def test_validate_config_ignores_categories_when_disabled(
    client: TestClient, tmp_path: Path
) -> None:
    # categorize disabled → an unsafe leftover category must not block validation.
    _post_valid_dirs(client, tmp_path, categorize_enabled=False, categorize_categories=[".."])
    data = client.post("/api/config/validate").json()
    assert data["valid"] is True
