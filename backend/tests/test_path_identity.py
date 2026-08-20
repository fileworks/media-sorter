"""C-06: one answer to "are these the same name?".

Four places asked that question and none normalised Unicode. macOS stores
filenames decomposed (NFD) while a name arriving from Windows, a camera, or a
zip is usually composed (NFC) — so `café.jpg` written one way and read the other
produced two different `casefold()` results.

The consequence was not cosmetic: a RAW/JPEG pair or an `.aae` sidecar with an
accented name was split into two media units, which orphans the sidecar from the
photo it belongs to.
"""

from __future__ import annotations

import unicodedata
from pathlib import Path

import pytest

from app.core.destination_paths import reserve_destination
from app.core.media_units import bind_media_units
from app.core.paths import path_identity_key, paths_refer_to_same_file

#: The same four names, composed and decomposed. `é`, `ü`, `ñ`, and a Korean
#: syllable whose NFD form is three jamo rather than an accent.
ACCENTED = ["café", "Müller", "mañana", "한글"]


class TestTheKeyItself:
    @pytest.mark.parametrize("name", ACCENTED)
    @pytest.mark.parametrize("case", ["lower", "upper", "title"])
    def test_the_two_unicode_forms_agree_across_every_case(self, name: str, case: str) -> None:
        """The property the plan asks for: (NFC, NFD) x (case)."""
        cased = getattr(name, case)()
        composed = unicodedata.normalize("NFC", cased)
        decomposed = unicodedata.normalize("NFD", cased)

        assert composed != decomposed or "".join(ACCENTED).isascii()
        assert path_identity_key(composed) == path_identity_key(decomposed)

    @pytest.mark.parametrize("name", ACCENTED)
    def test_case_is_folded_by_default_and_kept_on_request(self, name: str) -> None:
        assert path_identity_key(name.upper()) == path_identity_key(name.lower())

        if name.upper() == name.lower():
            # Hangul is caseless, so there is no case here to preserve. It stays
            # in the corpus because its NFD form is three jamo rather than a base
            # letter plus an accent — a genuinely different decomposition, and
            # the one most likely to break a naive key.
            pytest.skip(f"{name!r} has no case distinction")

        assert path_identity_key(name.upper(), case_sensitive=True) != path_identity_key(
            name.lower(), case_sensitive=True
        )

    @pytest.mark.parametrize("name", ACCENTED)
    def test_the_key_is_idempotent(self, name: str) -> None:
        once = path_identity_key(unicodedata.normalize("NFD", name))
        assert path_identity_key(once) == once

    def test_genuinely_different_names_stay_different(self) -> None:
        """A normaliser that collapses everything would also 'pass' the above."""
        assert path_identity_key("café") != path_identity_key("cafe")
        assert path_identity_key("a.jpg") != path_identity_key("b.jpg")


class TestMediaUnits:
    @pytest.mark.parametrize("name", ACCENTED)
    def test_an_accented_raw_and_jpeg_stay_one_unit(self, name: str, tmp_path: Path) -> None:
        """The failure this task exists for: a split unit orphans the sidecar."""
        root = tmp_path / "library"
        root.mkdir()
        # The pair as the filesystem might hand it back: one composed, one not.
        raw = root / (unicodedata.normalize("NFC", name) + ".ARW")
        jpeg = root / (unicodedata.normalize("NFD", name) + ".jpg")
        raw.write_bytes(b"raw")
        jpeg.write_bytes(b"jpeg")

        units, unmatched = bind_media_units([raw, jpeg], root)

        assert len(units) == 1, "the RAW and its JPEG were split into separate units"
        assert not unmatched
        assert {member.path.name for member in units[0].members} == {raw.name, jpeg.name}

    @pytest.mark.parametrize("name", ACCENTED)
    def test_an_accented_aae_sidecar_stays_bound(self, name: str, tmp_path: Path) -> None:
        root = tmp_path / "library"
        root.mkdir()
        jpeg = root / (unicodedata.normalize("NFC", name) + ".jpg")
        sidecar = root / (unicodedata.normalize("NFD", name) + ".aae")
        jpeg.write_bytes(b"jpeg")
        sidecar.write_bytes(b"<plist/>")

        units, unmatched = bind_media_units([jpeg, sidecar], root)

        assert not unmatched, "the sidecar was orphaned from its photo"
        assert len(units) == 1
        assert {member.path.suffix for member in units[0].members} == {".jpg", ".aae"}

    @pytest.mark.parametrize("name", ACCENTED)
    def test_the_unit_id_does_not_depend_on_the_stored_form(
        self, name: str, tmp_path: Path
    ) -> None:
        """The id is persisted and compared across runs."""
        root = tmp_path / "library"
        root.mkdir()
        composed = root / (unicodedata.normalize("NFC", name) + ".jpg")
        composed.write_bytes(b"jpeg")
        first, _ = bind_media_units([composed], root)

        decomposed_root = tmp_path / "library2"
        decomposed_root.mkdir()
        decomposed = decomposed_root / (unicodedata.normalize("NFD", name) + ".jpg")
        decomposed.write_bytes(b"jpeg")
        second, _ = bind_media_units([decomposed], decomposed_root)

        assert first[0].unit_id == second[0].unit_id


class TestReservation:
    @pytest.mark.parametrize("name", ACCENTED)
    def test_two_spellings_of_one_name_cannot_both_be_reserved(
        self, name: str, tmp_path: Path
    ) -> None:
        """Keyed by `Path`, both reserved and both planned onto the same file."""
        reserved: set[str] = set()
        composed = tmp_path / (unicodedata.normalize("NFC", name) + ".jpg")
        decomposed = tmp_path / (unicodedata.normalize("NFD", name) + ".jpg")

        first = reserve_destination(composed, reserved)
        second = reserve_destination(decomposed, reserved)

        assert first != second, "two planned files were given the same destination"
        assert second.stem.endswith("_001")

    def test_distinct_names_are_not_needlessly_suffixed(self, tmp_path: Path) -> None:
        reserved: set[str] = set()

        first = reserve_destination(tmp_path / "a.jpg", reserved)
        second = reserve_destination(tmp_path / "b.jpg", reserved)

        assert first.name == "a.jpg"
        assert second.name == "b.jpg"


class TestSameFileComparison:
    @pytest.mark.parametrize("name", ACCENTED)
    def test_the_two_forms_of_one_missing_path_compare_equal(
        self, name: str, tmp_path: Path
    ) -> None:
        """`samefile` cannot help when neither path exists yet."""
        composed = tmp_path / (unicodedata.normalize("NFC", name) + ".jpg")
        decomposed = tmp_path / (unicodedata.normalize("NFD", name) + ".jpg")

        assert paths_refer_to_same_file(composed, decomposed)

    def test_different_files_still_compare_unequal(self, tmp_path: Path) -> None:
        assert not paths_refer_to_same_file(tmp_path / "a.jpg", tmp_path / "b.jpg")
