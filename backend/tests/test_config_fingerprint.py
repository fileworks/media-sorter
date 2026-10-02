"""Configuration identity includes only fields that can alter a run."""

from app.core.config import Config
from app.core.config_fingerprint import config_fingerprint


def test_cache_preferences_do_not_stale_a_reviewed_plan() -> None:
    config = Config()
    reviewed = config_fingerprint(config)

    config.thumbnail_cache_enabled = False
    config.thumbnail_cache_budget_bytes = 1024
    config.update_check_enabled = False

    assert config_fingerprint(config) == reviewed


def test_locale_stales_plan_because_it_changes_bundled_operational_labels() -> None:
    config = Config()
    reviewed = config_fingerprint(config)

    config.language = "de"

    assert config_fingerprint(config) != reviewed


def test_operational_setting_changes_stale_a_reviewed_plan() -> None:
    config = Config()
    reviewed = config_fingerprint(config)

    config.rename = True

    assert config_fingerprint(config) != reviewed
