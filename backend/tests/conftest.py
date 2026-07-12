"""Shared test configuration and fixtures."""

from __future__ import annotations

import os
import tempfile
from collections.abc import Generator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.core.bootstrap import AppFactory
from app.core.config import Config
from app.core.database import DatabaseManager

# ------------------------------------------------------------------ #
# Test isolation (CRITICAL)                                           #
#                                                                     #
# conftest.py is imported before any test module, so pointing the     #
# config dir at a throwaway temp dir HERE guarantees every            #
# DatabaseManager()/ConfigLoader() — including the module-level       #
# AppFactory.create() calls in test_health / test_*_api / test_e2e — #
# resolves into temp storage instead of the developer's real config   #
# dir. Without this the suite writes operation rows into the live DB  #
# that the running app reads (History panel). See IMPLEMENTATION_PLAN #
# fix #6.                                                             #
# ------------------------------------------------------------------ #
_TEST_CONFIG_DIR = tempfile.mkdtemp(prefix="mediasort-tests-")
os.environ["MEDIASORT_CONFIG_DIR"] = _TEST_CONFIG_DIR
# A stale absolute DB path would override the isolated dir — drop it.
os.environ.pop("MEDIASORT_DB_PATH", None)


@pytest.fixture(scope="session", autouse=True)
def _assert_db_isolated() -> None:
    """Fail the whole suite if the DB ever resolves outside the temp dir."""
    resolved = str(DatabaseManager().db_path)
    assert resolved.startswith(_TEST_CONFIG_DIR), (
        f"Refusing to run: test DB path {resolved!r} is outside the isolated "
        f"test dir {_TEST_CONFIG_DIR!r}; tests would pollute the real database."
    )


# ------------------------------------------------------------------ #
# Application / HTTP client                                            #
# ------------------------------------------------------------------ #


@pytest.fixture(scope="module")
def test_config(tmp_path_factory: pytest.TempPathFactory) -> Config:
    """Module-scoped test configuration backed by temp directories."""
    base = tmp_path_factory.mktemp("mediasort")
    src = base / "source"
    dst = base / "target"
    src.mkdir(parents=True, exist_ok=True)
    dst.mkdir(parents=True, exist_ok=True)
    return Config(
        source_directory=str(src),
        target_directory=str(dst),
        sort=True,
        sort_criteria=["year", "month", "day"],
        recursive_scan=True,
        copy_instead_of_move=True,  # non-destructive during tests
        remove_duplicates=False,
    )


@pytest.fixture()
def fresh_config(tmp_path: Path) -> Config:
    """Per-test config with freshly created temp dirs (function scope)."""
    src = tmp_path / "source"
    dst = tmp_path / "dest"
    src.mkdir()
    dst.mkdir()
    return Config(
        source_directory=str(src),
        target_directory=str(dst),
        sort_criteria=["year", "month", "day"],
        copy_instead_of_move=True,
        remove_duplicates=False,
    )


@pytest.fixture()
def in_memory_db(tmp_path: Path) -> DatabaseManager:
    """DatabaseManager backed by a fresh per-test SQLite file."""
    db = DatabaseManager.__new__(DatabaseManager)
    db.db_dir = tmp_path
    db.db_path = tmp_path / "test.db"
    db.init_schema()
    return db


@pytest.fixture(scope="module")
def app(test_config: Config, tmp_path_factory: pytest.TempPathFactory):  # type: ignore[return]
    """FastAPI application wired with the test config and an isolated test DB."""
    db_path = str(tmp_path_factory.mktemp("test_app_db") / "mediasort.db")
    prev = os.environ.get("MEDIASORT_DB_PATH")
    os.environ["MEDIASORT_DB_PATH"] = db_path
    try:
        return AppFactory.create(test_config)
    finally:
        # DatabaseManager already captured db_path in __init__; restore the env
        # so other module-level fixtures/tests are not affected.
        if prev is None:
            os.environ.pop("MEDIASORT_DB_PATH", None)
        else:
            os.environ["MEDIASORT_DB_PATH"] = prev


@pytest.fixture(scope="module")
def client(app) -> TestClient:  # type: ignore[return]
    """TestClient for API integration tests (module scope)."""
    return TestClient(app)


# ------------------------------------------------------------------ #
# Sample media files                                                   #
# ------------------------------------------------------------------ #


@pytest.fixture()
def sample_jpeg_with_exif(tmp_path: Path) -> Path:
    """Return a JPEG with DateTimeOriginal = 2024-03-10."""
    piexif = pytest.importorskip("piexif")
    PIL_Image = pytest.importorskip("PIL.Image")

    img_path = tmp_path / "photo_with_exif.jpg"
    img = PIL_Image.new("RGB", (100, 100), color=(200, 100, 50))
    img.save(img_path, format="JPEG")

    exif_dict = {"Exif": {piexif.ExifIFD.DateTimeOriginal: b"2024:03:10 12:00:00"}}
    piexif.insert(piexif.dump(exif_dict), str(img_path))
    return img_path


@pytest.fixture()
def sample_jpeg_no_exif(tmp_path: Path) -> Path:
    """Return a JPEG without any EXIF data."""
    PIL_Image = pytest.importorskip("PIL.Image")
    img_path = tmp_path / "no_exif.jpg"
    img = PIL_Image.new("RGB", (80, 80), color=(0, 128, 255))
    img.save(img_path, format="JPEG")
    return img_path


@pytest.fixture()
def sample_corrupted_image(tmp_path: Path) -> Path:
    """Return a file with a truncated JPEG header (corrupted)."""
    img_path = tmp_path / "corrupted.jpg"
    img_path.write_bytes(b"\xff\xd8\xff\xe0\x00\x10JFIF")
    return img_path


@pytest.fixture()
def sample_directory_with_images(tmp_path: Path) -> Path:
    """Create a source directory containing 4 dated JPEGs."""
    piexif = pytest.importorskip("piexif")
    PIL_Image = pytest.importorskip("PIL.Image")

    source = tmp_path / "source"
    source.mkdir()

    dates_and_names = [
        ("2024:01:15 10:00:00", "photo_001.jpg"),
        ("2024:01:16 11:00:00", "photo_002.jpg"),
        ("2024:02:20 12:00:00", "photo_003.jpg"),
        ("2023:12:25 09:00:00", "photo_004.jpg"),
    ]

    for exif_date, name in dates_and_names:
        img_path = source / name
        img = PIL_Image.new("RGB", (100, 100))
        img.save(img_path, format="JPEG")
        exif_dict = {"Exif": {piexif.ExifIFD.DateTimeOriginal: exif_date.encode()}}
        piexif.insert(piexif.dump(exif_dict), str(img_path))

    return source


# ------------------------------------------------------------------ #
# Database helpers                                                      #
# ------------------------------------------------------------------ #


@pytest.fixture()
def test_db(tmp_path: Path) -> Generator[DatabaseManager, None, None]:
    """DatabaseManager pointing at a fresh temp file."""
    db = DatabaseManager.__new__(DatabaseManager)
    db.db_dir = tmp_path
    db.db_path = tmp_path / "test.db"
    db.init_schema()
    yield db


@pytest.fixture()
def db_with_operation(test_db: DatabaseManager):  # type: ignore[return]
    """DatabaseManager pre-populated with one operation and two file records."""
    operation_id = "test_op_001"
    with test_db._connect() as conn:
        conn.execute(
            """
            INSERT INTO operations
                (id, execution_date, source_path, dest_path, total_files,
                 files_sorted, files_failed, files_skipped, duplicates_found,
                 duration_seconds, config_hash)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                operation_id,
                "2024-05-17T14:30:00",
                "/source",
                "/dest",
                100,
                95,
                3,
                2,
                1,
                180,
                None,
            ),
        )
        conn.execute(
            """
            INSERT INTO file_operations
                (id, operation_id, source_path, dest_path, extracted_date,
                 metadata_source, action, status, error_message, file_size, file_type)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "file_op_001",
                operation_id,
                "/source/photo.jpg",
                "/dest/2024/01/photo.jpg",
                "2024-01-15",
                "exif",
                "copy",
                "success",
                None,
                1048576,
                ".jpg",
            ),
        )
        conn.execute(
            """
            INSERT INTO file_operations
                (id, operation_id, source_path, dest_path, extracted_date,
                 metadata_source, action, status, error_message, file_size, file_type)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "file_op_002",
                operation_id,
                "/source/broken.jpg",
                None,
                None,
                "none",
                "move",
                "unknown_date",
                None,
                512,
                ".jpg",
            ),
        )

    return operation_id, test_db


@pytest.fixture()
def sample_directory_with_mixed_types(tmp_path: Path) -> Path:
    """Create a source directory with mixed media types (JPEG, MP4, RAW stub)."""
    source = tmp_path / "source"
    source.mkdir()
    # MP4 stub
    (source / "video.mp4").write_bytes(b"\x00" * 1024)
    # RAW stub
    (source / "photo.arw").write_bytes(b"\x00" * 2048)
    return source
