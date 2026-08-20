"""`index_workers` — the machine's answer by default, the user's when they have one.

The derive pass ran at a module constant, `min(8, cpu_count)`. That is the right
number for almost every machine, and unreachable for the two where it is wrong:
a NAS that has to stay responsive to something else, and a laptop whose owner
would rather it stayed quiet. Neither could say so, because a constant is not a
setting.

Auto-detection stays the default — the point of the setting is that it can be
overridden, not that anybody has to.
"""

from __future__ import annotations

import pytest

from app.core.config import Config
from app.services.catalog_indexing import (
    DERIVE_WORKERS,
    MAX_DERIVE_WORKERS,
    resolve_derive_workers,
)


class TestTheDefaultIsStillAutomatic:
    def test_the_setting_defaults_to_asking_the_machine(self) -> None:
        assert Config().index_workers is None

    def test_unset_resolves_to_the_detected_count(self) -> None:
        assert resolve_derive_workers(None) == DERIVE_WORKERS

    def test_the_detected_count_is_sane(self) -> None:
        assert 1 <= DERIVE_WORKERS <= 8


class TestAnOverrideIsHonoured:
    @pytest.mark.parametrize("requested", [1, 2, 4, 16])
    def test_a_requested_count_is_used(self, requested: int) -> None:
        assert resolve_derive_workers(requested) == requested

    def test_one_worker_is_allowed_so_a_machine_can_index_gently(self) -> None:
        """The whole reason the setting exists: 'use one thread and leave me alone'."""
        assert resolve_derive_workers(1) == 1


class TestAnOverrideCannotBeAbsurd:
    @pytest.mark.parametrize("requested", [0, -1, -100])
    def test_a_nonsense_count_falls_back_to_automatic(self, requested: int) -> None:
        """Zero threads would index nothing at all, silently."""
        assert resolve_derive_workers(requested) == DERIVE_WORKERS

    def test_an_extravagant_count_is_capped(self) -> None:
        assert resolve_derive_workers(10_000) == MAX_DERIVE_WORKERS

    def test_the_cap_leaves_real_headroom_over_the_default(self) -> None:
        assert MAX_DERIVE_WORKERS > DERIVE_WORKERS


class TestTheSettingRoundTrips:
    def test_it_survives_a_save_and_load(self) -> None:
        assert Config.from_dict({"index_workers": 3}).index_workers == 3

    def test_it_is_accepted_by_a_config_update(self) -> None:
        from app.core.config import coerce_config_update

        coerced, errors = coerce_config_update({"index_workers": 2})
        assert errors == []
        assert coerced["index_workers"] == 2
