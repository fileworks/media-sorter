"""AI-01 / AI-02 / OPT-08 — offline location tags from the bundled GeoNames extract.

The retired ``reverse_geocoder`` package was never collected into the frozen
backend and every failure was swallowed, so location tags silently never worked
in installed builds. These tests run the real bundled data with real
coordinates, and pin the behaviour the review asked for: a distance cut-off,
validated coordinates, ``(0, 0)`` treated as a valid position, localized country
names, video locations, and one warning (without coordinates) when the data is
missing.
"""

from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path
from typing import Any

import pytest
from PIL import Image

from app.core.config import Config
from app.services.ai import ai_tagging_service as tagging
from app.services.ai import geo_lookup
from app.services.ai.ai_tagging_service import AITaggingService, _parse_iso6709

GEO = Path(geo_lookup.__file__).resolve().parents[2] / "resources" / "geo"
LICENSES = Path(__file__).resolve().parents[3] / "frontend" / "src-tauri" / "resources" / "licenses"


class TestTheBundledExtract:
    def test_files_match_their_recorded_checksums(self) -> None:
        source = json.loads((GEO / "SOURCE.json").read_text(encoding="utf-8"))
        for name, digest in source["sha256"].items():
            assert hashlib.sha256((GEO / name).read_bytes()).hexdigest() == digest
        assert source["license"] == "CC BY 4.0"

    def test_the_attribution_ships_with_the_app(self) -> None:
        notice = (LICENSES / "THIRD-PARTY-DATA.md").read_text(encoding="utf-8")
        assert "GeoNames" in notice
        assert "CC BY 4.0" in notice
        assert "Unicode License v3" in notice


class TestNearestPlace:
    @pytest.mark.parametrize(
        ("lat", "lon", "name", "code"),
        [
            (48.1374, 11.5755, "Munich", "DE"),
            (-33.8688, 151.2093, "Sydney", "AU"),
            (40.7128, -74.0060, "New York City", "US"),
            (-22.9068, -43.1729, "Rio de Janeiro", "BR"),
        ],
    )
    def test_real_coordinates_resolve_to_their_city(
        self, lat: float, lon: float, name: str, code: str
    ) -> None:
        place = geo_lookup.nearest_place(lat, lon)

        assert place is not None
        assert (place.name, place.country_code) == (name, code)
        assert place.distance_km < 5

    def test_the_open_ocean_has_no_nearest_town(self) -> None:
        assert geo_lookup.nearest_place(40.0, -30.0) is None

    def test_zero_zero_is_a_valid_position_with_nothing_nearby(self) -> None:
        assert geo_lookup.valid_coordinate(0.0, 0.0)
        assert geo_lookup.nearest_place(0.0, 0.0) is None

    def test_the_cut_off_is_a_real_distance(self) -> None:
        # About 40 km east of central Munich: beyond the cut-off from Munich,
        # so any match must be a closer place.
        place = geo_lookup.nearest_place(48.1374, 12.12)
        assert place is None or place.name != "Munich"
        assert place is None or place.distance_km <= geo_lookup.MAX_DISTANCE_KM

    @pytest.mark.parametrize(
        ("lat", "lon"),
        [(math.nan, 0.0), (0.0, math.inf), (90.5, 0.0), (0.0, -180.5), (-91.0, 10.0)],
    )
    def test_invalid_coordinates_are_rejected(self, lat: float, lon: float) -> None:
        assert not geo_lookup.valid_coordinate(lat, lon)
        with pytest.raises(ValueError):
            geo_lookup.nearest_place(lat, lon)

    def test_country_names_follow_the_language(self) -> None:
        place = geo_lookup.nearest_place(48.1374, 11.5755)
        assert place is not None
        assert place.country_name("de") == "Deutschland"
        assert place.country_name("en") == "Germany"
        assert place.country_name("xx") == "Germany"

    def test_the_table_is_read_only(self) -> None:
        geo_lookup.nearest_place(48.1374, 11.5755)
        table = geo_lookup._table()
        with pytest.raises(ValueError):
            table.vectors[0, 0] = 0.0


def _gps_jpeg(path: Path, lat: float, lon: float) -> None:
    def dms(value: float) -> tuple[float, float, float]:
        value = abs(value)
        degrees = int(value)
        minutes = int((value - degrees) * 60)
        seconds = round(((value - degrees) * 60 - minutes) * 60, 4)
        return (float(degrees), float(minutes), seconds)

    image = Image.new("RGB", (16, 16), "gray")
    exif = image.getexif()
    gps = exif.get_ifd(34853)
    gps[1] = "N" if lat >= 0 else "S"
    gps[2] = dms(lat)
    gps[3] = "E" if lon >= 0 else "W"
    gps[4] = dms(lon)
    image.save(path, format="JPEG", exif=exif)


def _service(language: str = "en", *, location: bool = True) -> AITaggingService:
    svc = AITaggingService(
        Config(ai_tagging_enabled=True, ai_location_tags_enabled=location, language=language)
    )
    svc._provider = None
    svc._provider_built = True
    return svc


class TestLocationTags:
    def test_a_geotagged_photo_gets_its_place_and_localized_country(self, tmp_path: Path) -> None:
        photo = tmp_path / "munich.jpg"
        _gps_jpeg(photo, 48.1374, 11.5755)

        assert _service("de").tag_file(photo) == ["Munich", "Deutschland"]
        assert _service("en").tag_file(photo) == ["Munich", "Germany"]

    def test_location_tags_need_their_own_opt_in(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """AI-NEW-6: content tagging alone never adds where a photo was taken."""
        photo = tmp_path / "munich.jpg"
        _gps_jpeg(photo, 48.1374, 11.5755)
        clip = tmp_path / "clip.mov"
        clip.write_bytes(b"\x00")
        probes: list[Path] = []
        monkeypatch.setattr(tagging, "run_ffprobe_json", lambda p, _e: probes.append(p))
        monkeypatch.setattr(tagging, "probe_duration", lambda _p: None)

        assert _service(location=False).tag_file(photo) == []
        assert _service(location=False).tag_file(clip) == []
        assert probes == []
        assert Config().ai_location_tags_enabled is False

    def test_a_photo_at_sea_gets_no_location(self, tmp_path: Path) -> None:
        photo = tmp_path / "sea.jpg"
        _gps_jpeg(photo, 40.0, -30.0)

        assert _service().tag_file(photo) == []

    def test_a_video_location_is_read_from_its_container(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        clip = tmp_path / "clip.mov"
        clip.write_bytes(b"\x00")
        monkeypatch.setattr(
            tagging,
            "run_ffprobe_json",
            lambda _p, _e: {
                "format": {
                    "tags": {"com.apple.quicktime.location.ISO6709": "-33.8688+151.2093+012.000/"}
                }
            },
        )
        monkeypatch.setattr(tagging, "probe_duration", lambda _p: None)

        assert _service().tag_file(clip) == ["Sydney", "Australia"]

    def test_a_missing_ffprobe_means_no_video_location(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        clip = tmp_path / "clip.mp4"
        clip.write_bytes(b"\x00")

        def _missing(*_args: Any) -> None:
            raise FileNotFoundError("ffprobe")

        monkeypatch.setattr(tagging, "run_ffprobe_json", _missing)
        monkeypatch.setattr(tagging, "probe_duration", lambda _p: None)

        assert _service().tag_file(clip) == []

    def test_missing_data_warns_once_without_the_coordinates(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        def _broken(*_args: Any) -> None:
            raise geo_lookup.GeoDataError("cities.tsv.gz is not bundled")

        warnings: list[tuple[str, dict[str, Any]]] = []
        monkeypatch.setattr(tagging, "nearest_place", _broken)
        monkeypatch.setattr(
            tagging.logger, "warning", lambda event, **fields: warnings.append((event, fields))
        )
        svc = _service()

        assert svc._location_tags((48.1374, 11.5755)) == []
        assert svc._location_tags((52.52, 13.405)) == []
        assert warnings == [
            ("Location tags unavailable", {"reason": "cities.tsv.gz is not bundled"})
        ]
        assert "48.1" not in repr(warnings)


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("+48.8577+002.2950/", (48.8577, 2.295)),
        ("-33.8688+151.2093+012.000/", (-33.8688, 151.2093)),
        ("+00.0000+000.0000/", (0.0, 0.0)),
        ("garbage", None),
        ("", None),
        (None, None),
    ],
)
def test_iso6709_decimal_degrees_are_parsed(value: object, expected: object) -> None:
    assert _parse_iso6709(value) == expected


class TestLocationSettingMigration:
    def test_a_saved_config_with_tagging_keeps_location_tags(self) -> None:
        assert Config.from_dict({"ai_tagging_enabled": True}).ai_location_tags_enabled is True

    def test_a_saved_config_without_tagging_gets_the_new_default(self) -> None:
        assert Config.from_dict({"ai_tagging_enabled": False}).ai_location_tags_enabled is False

    def test_an_explicit_choice_is_kept(self) -> None:
        config = Config.from_dict({"ai_tagging_enabled": True, "ai_location_tags_enabled": False})
        assert config.ai_location_tags_enabled is False
