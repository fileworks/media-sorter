from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path

from fastapi.testclient import TestClient
from PIL import Image

from app.core.bootstrap import AppFactory
from app.core.config import Config
from app.core.integrity import OptimizationProfile, PreservationProfile


def _recipe_config(recipe: str, source: Path, destination: Path) -> Config:
    """The configuration each built-in recipe writes, as the frontend writes it.

    Mirrors `frontend/src/lib/configRecipes.ts`. The point of the test below is
    that a recipe is usable *as applied* — validation passes and a preview runs
    without the user having to fix anything the recipe left inconsistent.
    """
    if recipe == "safe_sort":
        return Config(
            source_directory=str(source),
            target_directory=str(destination),
            sort=True,
            sort_criteria=["year", "month"],
            copy_instead_of_move=True,
            remove_duplicates=True,
            duplicate_exact_enabled=True,
            duplicate_perceptual_enabled=True,
            junk_filter_enabled=False,
            convert_images=False,
            convert_videos=False,
            repair_enabled=False,
        )

    if recipe == "clean_sweep":
        return Config(
            source_directory=str(source),
            target_directory=str(destination),
            sort=True,
            sort_criteria=["year", "month"],
            copy_instead_of_move=False,
            remove_duplicates=True,
            duplicate_exact_enabled=True,
            duplicate_perceptual_enabled=True,
            junk_filter_enabled=True,
            convert_images=False,
            convert_videos=False,
            repair_enabled=False,
        )

    if recipe == "scratch":
        return Config(
            source_directory=str(source),
            target_directory=str(destination),
            sort=False,
            copy_instead_of_move=True,
            remove_duplicates=False,
            duplicate_exact_enabled=False,
            duplicate_perceptual_enabled=False,
            junk_filter_enabled=False,
            rename=False,
            categorize_enabled=False,
            convert_images=False,
            convert_videos=False,
            repair_enabled=False,
            rules_enabled=False,
            ai_tagging_enabled=False,
        )

    acknowledged = datetime.now(timezone.utc)
    return Config(
        source_directory=str(source),
        target_directory=str(destination),
        sort=True,
        sort_criteria=["year", "month"],
        copy_instead_of_move=True,
        remove_duplicates=True,
        duplicate_exact_enabled=True,
        duplicate_perceptual_enabled=True,
        junk_filter_enabled=True,
        convert_images=True,
        image_format="jpeg",
        convert_videos=True,
        video_format="mp4",
        repair_enabled=True,
        preservation_profile=PreservationProfile(
            profile_id="recipe-explicit-mutation",
            name="Recipe explicit mutation",
            mode="explicit_mutation",
            allow_repair=True,
            allow_conversion=True,
            allow_compression=True,
            authorization_origin="run_override",
            acknowledged_at=acknowledged,
        ),
        optimization_profile=OptimizationProfile(
            profile_id="recipe-visually-lossless",
            name="Recipe: visually lossless conversion",
            mode="visually_lossless",
            acknowledged_at=acknowledged,
            tool="bundled",
            tool_version="managed",
            validation_contract="recipe-preview-v1",
            retain_original=True,
        ),
    )


def test_every_recipe_validates_and_previews_without_follow_up_edits(tmp_path: Path) -> None:
    for recipe in ("safe_sort", "clean_sweep", "archive_convert", "scratch"):
        source = tmp_path / recipe / "source"
        destination = tmp_path / recipe / "destination"
        source.mkdir(parents=True)
        destination.mkdir()
        Image.new("RGB", (24, 24), (30, 60, 90)).save(
            source / "2026-07-28-photo.jpg",
            format="JPEG",
        )
        config = _recipe_config(recipe, source, destination)

        with TestClient(AppFactory.create(config=config)) as client:
            validation = client.post("/api/config/validate")
            preview = client.post("/api/preview")

        assert validation.status_code == 200
        assert validation.json()["valid"], (recipe, validation.json()["errors"])
        assert preview.status_code == 200
        assert preview.json()["stats"]["total"] == 1


def test_saved_recipes_round_trip_through_their_own_endpoints(tmp_path: Path) -> None:
    """Saving, listing, replacing and deleting a recipe, without a full config write."""
    source = tmp_path / "source"
    destination = tmp_path / "destination"
    source.mkdir()
    destination.mkdir()
    config = _recipe_config("safe_sort", source, destination)

    with TestClient(AppFactory.create(config=config)) as client:
        assert client.get("/api/config/recipes").json() == []

        created = client.post(
            "/api/config/recipes",
            json={"name": "  My   weekend   sort ", "settings": {"copy_instead_of_move": True}},
        )
        assert created.status_code == 201
        recipe = created.json()
        # Whitespace is collapsed rather than preserved: the name is a label.
        assert recipe["name"] == "My weekend sort"
        assert recipe["settings"]["copy_instead_of_move"] is True
        # Settings the caller omitted come back as the documented defaults, so a
        # recipe written by an older build still restores a complete posture.
        assert recipe["settings"]["duplicate_keeper_policy"] == "newest"

        listed = client.get("/api/config/recipes").json()
        assert [entry["recipe_id"] for entry in listed] == [recipe["recipe_id"]]

        # Saving the same name replaces rather than accumulating a second entry.
        replaced = client.post(
            "/api/config/recipes",
            json={"name": "my weekend sort", "settings": {"copy_instead_of_move": False}},
        )
        assert replaced.status_code == 201
        listed = client.get("/api/config/recipes").json()
        assert len(listed) == 1
        assert listed[0]["settings"]["copy_instead_of_move"] is False

        # The saved list survives a normal config read.
        assert len(client.get("/api/config").json()["saved_recipes"]) == 1

        assert client.delete(f"/api/config/recipes/{listed[0]['recipe_id']}").status_code == 204
        assert client.get("/api/config/recipes").json() == []
        # Deleting something already gone is not an error.
        assert client.delete("/api/config/recipes/does-not-exist").status_code == 204


def test_saved_recipe_preserves_every_recent_behavior_setting(tmp_path: Path) -> None:
    """The save boundary must not silently discard settings the UI captures.

    Pydantic intentionally ignores unknown fields for forward compatibility, so
    a frontend/backend schema drift otherwise looks like a successful save and
    only becomes visible when the recipe is applied later.  Exercise a value
    from each recently added group to keep the two explicit models aligned.
    """
    source = tmp_path / "source"
    destination = tmp_path / "destination"
    source.mkdir()
    destination.mkdir()

    with TestClient(
        AppFactory.create(config=_recipe_config("safe_sort", source, destination))
    ) as client:
        response = client.post(
            "/api/config/recipes",
            json={
                "name": "Exact behavior",
                "settings": {
                    "run_mode": "deduplicate_only",
                    "recursive_scan": False,
                    "max_recursion_depth": 3,
                    "preserve_subfolders": True,
                    "override_metadata": True,
                    "companion_handling": "leave_in_place",
                    "burst_detection_enabled": True,
                    "burst_time_window_seconds": 7.5,
                    "junk_min_file_size_kb": 32,
                    "junk_filename_patterns": ["*.cache"],
                    "categorize_confidence_threshold": 0.7,
                    "ai_tagging_max_tags": 4,
                    "exclude_patterns": ["*.tmp"],
                    "min_file_size_kb": 64,
                    "max_file_size_mb": 512,
                    "camera_subfolder_enabled": True,
                    "exif_sanity_check_enabled": False,
                },
            },
        )

        assert response.status_code == 201
        settings = response.json()["settings"]
        assert settings["run_mode"] == "deduplicate_only"
        assert settings["recursive_scan"] is False
        assert settings["max_recursion_depth"] == 3
        assert settings["preserve_subfolders"] is True
        assert settings["override_metadata"] is True
        assert settings["companion_handling"] == "leave_in_place"
        assert settings["burst_detection_enabled"] is True
        assert settings["burst_time_window_seconds"] == 7.5
        assert settings["junk_min_file_size_kb"] == 32
        assert settings["junk_filename_patterns"] == ["*.cache"]
        assert settings["categorize_confidence_threshold"] == 0.7
        assert settings["ai_tagging_max_tags"] == 4
        assert settings["exclude_patterns"] == ["*.tmp"]
        assert settings["min_file_size_kb"] == 64
        assert settings["max_file_size_mb"] == 512
        assert settings["camera_subfolder_enabled"] is True
        assert settings["exif_sanity_check_enabled"] is False

        assert client.get("/api/config/recipes").json()[0]["settings"] == settings


def test_a_saved_recipe_refuses_a_blank_name_or_a_built_in_id(tmp_path: Path) -> None:
    source = tmp_path / "source"
    destination = tmp_path / "destination"
    source.mkdir()
    destination.mkdir()
    config = _recipe_config("safe_sort", source, destination)

    with TestClient(AppFactory.create(config=config)) as client:
        blank = client.post("/api/config/recipes", json={"name": "   ", "settings": {}})
        assert blank.status_code == 422

        # A recipe cannot be written straight into the config under a built-in
        # id, which would shadow a card the frontend ships.
        shadowed = client.post(
            "/api/config",
            json={
                "saved_recipes": [{"recipe_id": "safe_sort", "name": "Impostor", "settings": {}}]
            },
        )
        assert shadowed.status_code == 422


def test_a_recipe_leaves_no_setting_requesting_a_rewrite_it_did_not_authorize(
    tmp_path: Path,
) -> None:
    """The bug this test exists to prevent, stated as the backend sees it.

    `_requested_capabilities` counts `override_metadata`, and
    `ai_tagging_enabled and embed_tags_in_files`, as requests to rewrite file
    bytes. Every recipe but *Archive & convert* declares `organize_only`, which
    authorizes none of that — so a recipe leaving either switch on produced a
    configuration the backend refuses, disabling "Preview changes" and naming
    four settings the user never touched.

    The frontend now clears them in the same patch that sets the profile. This
    asserts the resulting configuration is one the backend accepts, which is the
    only claim that matters.
    """
    for recipe in ("safe_sort", "clean_sweep", "scratch"):
        source = tmp_path / f"clean-{recipe}" / "source"
        destination = tmp_path / f"clean-{recipe}" / "destination"
        source.mkdir(parents=True)
        destination.mkdir()

        # Tagging stays on: it is not a rewrite on its own, and a recipe that
        # switched it off would be taking away a setting it never claimed.
        config = replace(
            _recipe_config(recipe, source, destination),
            ai_tagging_enabled=True,
            embed_tags_in_files=False,
            override_metadata=False,
        )

        with TestClient(AppFactory.create(config=config)) as client:
            validation = client.post("/api/config/validate")

        assert validation.status_code == 200
        assert validation.json()["valid"], (recipe, validation.json()["errors"])


def test_leaving_metadata_overwriting_on_under_organize_only_is_refused(tmp_path: Path) -> None:
    """The negative control: the rule the frontend mirrors is real.

    Without this, the test above could pass because nothing validates rather
    than because the recipe is coherent.
    """
    source = tmp_path / "refused" / "source"
    destination = tmp_path / "refused" / "destination"
    source.mkdir(parents=True)
    destination.mkdir()
    config = replace(_recipe_config("safe_sort", source, destination), override_metadata=True)

    with TestClient(AppFactory.create(config=config)) as client:
        validation = client.post("/api/config/validate")

    assert validation.status_code == 200
    assert not validation.json()["valid"]
