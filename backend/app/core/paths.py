"""Stable application-state paths shared by backend subsystems."""

from __future__ import annotations

import os
import platform
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

from platformdirs import PlatformDirs

APP_NAME = "MediaSorter"
LEGACY_APP_NAME = "mediasort"


@dataclass(frozen=True)
class AppPaths:
    """Resolved current paths and whether an operator explicitly selected them."""

    config_dir: Path
    data_dir: Path
    log_dir: Path
    db_path: Path
    config_overridden: bool
    data_overridden: bool
    log_overridden: bool
    db_overridden: bool

    @property
    def config_file(self) -> Path:
        return self.config_dir / "config.json"

    @property
    def migration_manifest(self) -> Path:
        return self.data_dir / "state-migration-v1.json"


@dataclass(frozen=True)
class LegacyPaths:
    config_file: Path
    db_path: Path
    log_dir: Path


def resolve_app_paths(
    env: Mapping[str, str] | None = None,
    *,
    dirs: PlatformDirs | None = None,
) -> AppPaths:
    """Resolve the current config, non-roaming data, database, and log paths.

    ``MEDIASORT_CONFIG_DIR`` historically housed both config and the database.
    Keeping that coupling only when no newer data/database override is present
    preserves Docker/headless deployments while fresh desktop installs use the
    dedicated platformdirs data location.
    """

    values = os.environ if env is None else env
    platform_dirs = dirs or PlatformDirs(APP_NAME, appauthor=False, roaming=False)

    config_override = values.get("MEDIASORT_CONFIG_DIR")
    data_override = values.get("MEDIASORT_DATA_DIR")
    db_override = values.get("MEDIASORT_DB_PATH")
    log_override = values.get("MEDIASORT_LOG_DIR")

    config_dir = Path(config_override) if config_override else Path(platform_dirs.user_config_path)
    if data_override:
        data_dir = Path(data_override)
    elif config_override and not db_override:
        data_dir = config_dir
    else:
        data_dir = Path(platform_dirs.user_data_path)

    db_path = Path(db_override) if db_override else data_dir / "mediasort.db"
    log_dir = Path(log_override) if log_override else Path(platform_dirs.user_log_path)

    return AppPaths(
        config_dir=config_dir,
        data_dir=data_dir,
        log_dir=log_dir,
        db_path=db_path,
        config_overridden=config_override is not None,
        data_overridden=data_override is not None,
        log_overridden=log_override is not None,
        db_overridden=db_override is not None,
    )


def resolve_legacy_paths(
    env: Mapping[str, str] | None = None,
    *,
    dirs: PlatformDirs | None = None,
    system: str | None = None,
) -> LegacyPaths:
    """Return the exact historical lowercase state and split-log locations."""

    values = os.environ if env is None else env
    legacy_dirs = dirs or PlatformDirs(
        LEGACY_APP_NAME,
        LEGACY_APP_NAME,
        roaming=False,
    )
    legacy_config_dir = Path(legacy_dirs.user_config_path)
    platform_name = system or platform.system()

    if platform_name == "Darwin":
        home = Path(values.get("HOME", str(Path.home())))
        log_dir = home / "Library" / "Logs" / APP_NAME
    elif platform_name == "Windows":
        base = (
            values.get("LOCALAPPDATA")
            or values.get("APPDATA")
            or values.get("USERPROFILE")
            or str(Path.home())
        )
        log_dir = Path(base) / APP_NAME / "logs"
    else:
        data_home = values.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
        log_dir = Path(data_home) / LEGACY_APP_NAME / "logs"

    return LegacyPaths(
        config_file=legacy_config_dir / "config.json",
        db_path=legacy_config_dir / "mediasort.db",
        log_dir=log_dir,
    )


def paths_refer_to_same_file(first: Path, second: Path) -> bool:
    """Compare existing aliases safely, with a normalized fallback."""

    try:
        if first.exists() and second.exists():
            return first.samefile(second)
    except OSError:
        pass

    first_resolved = first.expanduser().resolve(strict=False)
    second_resolved = second.expanduser().resolve(strict=False)
    return os.path.normcase(str(first_resolved)) == os.path.normcase(str(second_resolved))
