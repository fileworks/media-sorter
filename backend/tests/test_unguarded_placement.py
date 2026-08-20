"""C-14: the unguarded placement path must not touch a reference root.

`_place` and `_quarantine_transfer` fall back to `safe_move`/`safe_copy` when
there is no `OperationExecution`. That fallback skips all three guarantees
`execution.place` provides:

* `_assert_not_protected` — so a comparison-only reference root could be written
  to by the one path that never checks;
* the frozen-plan guard — so an unplanned placement could happen;
* the action journal — so nothing recorded that it did.

Reference roots exist so a user can deduplicate *against* a library they do not
want reorganized. That promise cannot depend on which code path happened to run.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.core.config import Config
from app.core.exceptions import MutationPolicyError
from app.core.library_profiles import LibraryProfile, LibraryRoot
from app.services.config_service import ConfigService
from app.services.sorting_support import SortingSupportMixin


class _Harness(SortingSupportMixin):
    """The mixin alone, with only what the guard reads."""

    def __init__(self, config: Config) -> None:
        self._config_service = ConfigService(config)


def _config_with_reference(tmp_path: Path) -> tuple[Config, Path]:
    reference = tmp_path / "reference-library"
    reference.mkdir()
    profile = LibraryProfile(
        profile_id="p1",
        name="test",
        roots=[
            LibraryRoot(root_id="in", role="input", path=str(tmp_path / "source")),
            LibraryRoot(root_id="out", role="destination", path=str(tmp_path / "target")),
            LibraryRoot(root_id="ref", role="reference", path=str(reference)),
        ],
    )
    config = Config(
        source_directory=str(tmp_path / "source"),
        target_directory=str(tmp_path / "target"),
        library_profile=profile,
    )
    return config, reference


class TestProtectedRootsWithoutAnExecution:
    def test_a_source_inside_a_reference_root_is_refused(self, tmp_path: Path) -> None:
        config, reference = _config_with_reference(tmp_path)
        harness = _Harness(config)

        with pytest.raises(MutationPolicyError) as raised:
            harness._refuse_protected_without_execution(
                reference / "original.jpg", tmp_path / "target" / "original.jpg"
            )

        assert raised.value.details["role"] == "source"
        assert raised.value.details["reason"] == "reference_root_is_immutable"

    def test_a_destination_inside_a_reference_root_is_refused(self, tmp_path: Path) -> None:
        config, reference = _config_with_reference(tmp_path)
        harness = _Harness(config)

        with pytest.raises(MutationPolicyError) as raised:
            harness._refuse_protected_without_execution(
                tmp_path / "source" / "a.jpg", reference / "nested" / "a.jpg"
            )

        assert raised.value.details["role"] == "destination"

    def test_the_reference_root_itself_is_refused(self, tmp_path: Path) -> None:
        config, reference = _config_with_reference(tmp_path)
        harness = _Harness(config)

        with pytest.raises(MutationPolicyError):
            harness._refuse_protected_without_execution(reference, tmp_path / "target")

    def test_paths_outside_every_reference_root_are_allowed(self, tmp_path: Path) -> None:
        config, _ = _config_with_reference(tmp_path)
        harness = _Harness(config)

        harness._refuse_protected_without_execution(
            tmp_path / "source" / "a.jpg", tmp_path / "target" / "a.jpg"
        )

    def test_a_library_with_no_reference_roots_is_unaffected(self, tmp_path: Path) -> None:
        """The ordinary case must not pay for the guard."""
        config = Config(
            source_directory=str(tmp_path / "source"),
            target_directory=str(tmp_path / "target"),
        )
        harness = _Harness(config)

        harness._refuse_protected_without_execution(
            tmp_path / "source" / "a.jpg", tmp_path / "target" / "a.jpg"
        )


def test_no_placement_helper_transfers_without_consulting_the_guard() -> None:
    """Acceptance: `sorting_support` may not call `safe_move`/`safe_copy` unguarded.

    A grep, because the defect is a *shape*: the next person to add a fallback
    should be stopped by a failing test rather than by a review that may not
    happen.
    """
    source = Path(__file__).resolve().parents[1] / "app" / "services" / "sorting_support.py"
    body = source.read_text(encoding="utf-8")

    guard = "_refuse_protected_without_execution"
    # Every `execution is None` branch that reaches a transfer consults the guard
    # first. Both branches are inside helpers whose bodies are short enough to
    # check by locality.
    for marker in ("self._fs.safe_move(", "self._fs.safe_copy("):
        index = body.index(marker)
        preceding = body[max(0, index - 600) : index]
        assert guard in preceding, f"{marker} is reachable without the protected-root guard"

    assert body.count(guard) >= 3, "the guard is defined and used at both transfer sites"
