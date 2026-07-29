from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from fastapi.testclient import TestClient
from PIL import Image

from app.core.bootstrap import AppFactory
from app.core.config import Config
from app.core.integrity import OptimizationProfile, PreservationProfile


def _recipe_config(recipe: str, source: Path, destination: Path) -> Config:
    common = {
        "source_directory": str(source),
        "target_directory": str(destination),
        "remove_duplicates": True,
        "duplicate_exact_enabled": True,
        "duplicate_perceptual_enabled": True,
    }
    if recipe == "duplicates_only":
        return Config(
            **common,
            sort=False,
            copy_instead_of_move=True,
            convert_images=False,
            convert_videos=False,
            repair_enabled=False,
        )

    acknowledged = datetime.now(timezone.utc)
    return Config(
        **common,
        sort=True,
        sort_criteria=["year"],
        copy_instead_of_move=recipe == "copy_cleanup",
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
    for recipe in ("duplicates_only", "full_cleanup", "copy_cleanup"):
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
