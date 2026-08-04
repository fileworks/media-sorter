from __future__ import annotations

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
