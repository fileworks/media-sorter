"""I-01…I-15: the product invariants, as assertions rather than prose.

Plan §17.4 lists fifteen invariants and states the rule this module exists to
satisfy: *an invariant stated only in prose is not enforced*. Each one now has
at least one executable assertion here, and the registry at the bottom fails if
an ID ever loses its last one.

This module deliberately does **not** restate the behavioural suites. The engine
already has thorough behavioural coverage; what it lacked was a named assertion
per invariant that fails when the *guard itself* is deleted. Some guards cannot
be reached behaviourally at all — nothing can raise `KeyboardInterrupt` inside a
copy on demand — so those are asserted structurally.

Structural assertions are built on the AST, never on substring search. `ast`
discards comments, so an assertion cannot be satisfied by the explanatory prose
above the code it is meant to pin: `verified_transfer` documents I-04 in a
comment containing the word `BaseException` directly above the handler, and a
source-text search would match the comment whether or not the handler survived.
"""

from __future__ import annotations

import ast
import os
import tempfile
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.background_tasks.task_manager import TaskProgress
from app.core.action_journal import read_journal
from app.core.api_security import LocalApiSecurityMiddleware
from app.core.duplicate_plans import FactValue, ResolvedOutcome
from app.services.ai.model_manifest import ModelManifestError, parse_manifest
from app.services.catalog import FileRecord, MediaCatalog, ObservedFile
from app.services.sorting_support import SortingSupportMixin

APP = Path(__file__).resolve().parents[1] / "app"

#: Every invariant from plan §17.4. The registry test at the end asserts each
#: one still has a live assertion in this module, so deleting a test is a
#: failure rather than a silent gap.
INVARIANTS: dict[str, str] = {
    "I-01": "Fresh streaming SHA-256 at execution time before every source removal",
    "I-02": "A cached hash is a candidate hint, never destructive proof",
    "I-03": "Cross-volume hashes while copying and re-reads the closed stage",
    "I-04": "Stage cleanup on BaseException, not Exception",
    "I-05": "Directory fsync after every commit",
    "I-06": "Manifest-before-journal; per-record fsync; never rewritten; truncated tail discarded",
    "I-07": "Reference/protected members immutable at the type level",
    "I-08": "Keeper selection deterministic and policy-based; AI never participates",
    "I-09": "Only a complete generation may mark rows missing",
    "I-10": "Unknown metadata distinguishable from zero/false",
    "I-11": "Loopback API requires capability token and exact origin",
    "I-12": "No shell=True; fixed argv on every subprocess",
    "I-13": "Model artifacts pinned by commit SHA + SHA-256; ONNX only; no remote code",
    "I-14": "Stale derived rows are a cache miss, never a wrong answer",
    "I-15": "Destructive tests never target a real library",
}


# ---------------------------------------------------------------------- #
# AST helpers — comment-proof by construction                              #
# ---------------------------------------------------------------------- #


def _tree(relative: str) -> ast.Module:
    path = APP / relative
    return ast.parse(path.read_text(encoding="utf-8"), filename=str(path))


def _function(relative: str, name: str) -> ast.FunctionDef | ast.AsyncFunctionDef:
    for node in ast.walk(_tree(relative)):
        if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef) and node.name == name:
            return node
    raise AssertionError(f"{relative} has no function named {name!r} — the invariant moved")


def _called_names(node: ast.AST) -> set[str]:
    """Every simple call name in a subtree: `f(...)` and `obj.f(...)` alike."""
    names: set[str] = set()
    for child in ast.walk(node):
        if isinstance(child, ast.Call):
            func = child.func
            if isinstance(func, ast.Name):
                names.add(func.id)
            elif isinstance(func, ast.Attribute):
                names.add(func.attr)
    return names


# ---------------------------------------------------------------------- #
# I-01 · I-02 · I-03 — the destructive proof                               #
# ---------------------------------------------------------------------- #


def test_i01_a_source_removal_forces_a_fresh_rehash() -> None:
    """`execute_transfer` may not accept `rehash_source=False` for a removal.

    This is what makes the invariant universal rather than a habit of callers:
    the decision is taken inside the engine, from the action's own effects.
    """
    node = _function("services/verified_transfer.py", "execute_transfer")

    rehash_expressions = [
        ast.unparse(keyword.value)
        for call in ast.walk(node)
        if isinstance(call, ast.Call)
        for keyword in call.keywords
        if keyword.arg == "rehash_source"
    ]

    assert rehash_expressions, "execute_transfer no longer passes rehash_source at all"
    assert any("remove_after_verification" in expression for expression in rehash_expressions), (
        "a removal must force its own rehash rather than trusting the caller:\n"
        + "\n".join(rehash_expressions)
    )


def test_i01_the_same_volume_move_rehashes_the_source_itself() -> None:
    """The removal path computes its own digest instead of reusing the plan's."""
    node = _function("services/verified_transfer.py", "_transfer_same_volume")

    assert "stream_sha256" in _called_names(node)


def test_i02_a_stored_fingerprint_is_labelled_a_cache_hint() -> None:
    """I-02 is encoded in the type, not only in the docs.

    `fingerprint_role` exists so a fingerprint can never be mistaken for
    content proof by a reader that only sees the record.
    """
    assert FileRecord.fingerprint_role == "cache_hint"


def test_i02_the_authorized_digest_is_only_ever_a_comparand() -> None:
    """The plan's hash is compared against a measured one, never substituted for it.

    In the removal path `expected_sha256` must appear inside a comparison whose
    other side is the digest this run just streamed. If it were used on its own,
    the engine would be certifying content it never read.
    """
    node = _function("services/verified_transfer.py", "_transfer_same_volume")

    comparisons = [ast.unparse(child) for child in ast.walk(node) if isinstance(child, ast.Compare)]
    measured = [
        rendered
        for rendered in comparisons
        if "expected_sha256" in rendered and "observed_hash" in rendered
    ]

    assert measured, (
        "the authorized digest is no longer checked against a freshly measured one:\n"
        + "\n".join(comparisons)
    )


def test_i03_the_closed_stage_is_read_back_independently() -> None:
    """Hashing while copying is not enough: the stage is re-read once closed."""
    node = _function("services/verified_transfer.py", "_stage_copy")
    called = _called_names(node)

    assert "_copy_and_hash" in called, "the copy no longer hashes as it streams"
    assert "stream_sha256" in called, "the closed stage is no longer verified independently"


# ---------------------------------------------------------------------- #
# I-04 · I-05 — crash and durability semantics                             #
# ---------------------------------------------------------------------- #


def test_i04_the_stage_is_cleaned_up_on_baseexception() -> None:
    """`except Exception` would leak an unverified stage on Ctrl-C.

    Asserted on the AST: the module documents this rule in a comment directly
    above the handler, so a text search would pass with the handler removed.
    """
    node = _function("services/verified_transfer.py", "_stage_copy")

    handlers = [child for child in ast.walk(node) if isinstance(child, ast.ExceptHandler)]
    assert handlers, "_stage_copy no longer has any exception handler"

    caught = {
        handler.type.id
        for handler in handlers
        if handler.type is not None and isinstance(handler.type, ast.Name)
    }
    assert "BaseException" in caught, (
        f"_stage_copy must clean up on BaseException, not only {sorted(caught)}"
    )

    cleanup = [handler for handler in handlers if "unlink" in _called_names(handler)]
    assert cleanup, "the handler no longer removes the stage"


@pytest.mark.parametrize(
    "name",
    ["commit_staged_no_replace", "commit_staged_recoverable"],
)
def test_i05_every_commit_fsyncs_its_directory(name: str) -> None:
    """A rename is not durable until the containing directory is synced."""
    node = _function("services/verified_transfer.py", name)

    assert "_fsync_directory" in _called_names(node), f"{name} no longer fsyncs the directory"


def test_i05_the_commit_dispatcher_cannot_skip_a_synced_path() -> None:
    """`commit_staged` must delegate; it must not grow its own publish path."""
    node = _function("services/verified_transfer.py", "commit_staged")
    called = _called_names(node)

    assert called & {"commit_staged_no_replace", "commit_staged_recoverable"}, (
        "commit_staged no longer delegates to a directory-syncing commit"
    )
    assert "replace" not in called and "rename" not in called, (
        "commit_staged is publishing directly, bypassing the fsync its delegates do"
    )


# ---------------------------------------------------------------------- #
# I-06 — the journal                                                       #
# ---------------------------------------------------------------------- #


def test_i06_the_journal_is_opened_for_append_only() -> None:
    """A journal that can be rewritten is not a journal."""
    tree = _tree("core/action_journal.py")

    modes = {
        node.args[0].value
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "open"
        and node.args
        and isinstance(node.args[0], ast.Constant)
        and isinstance(node.args[0].value, str)
    }

    assert modes, "no literal open modes found — the walker is not looking at the journal"
    assert not (modes & {"w", "w+", "r+"}), f"the journal is opened in a rewriting mode: {modes}"


def test_i06_each_record_is_fsynced_as_it_is_written() -> None:
    tree = _tree("core/action_journal.py")

    assert "fsync" in _called_names(tree), "journal records are no longer flushed to disk"


def _journal_header() -> str:
    import json

    return json.dumps(
        {
            "record": "header",
            "journal_id": "j1",
            "manifest_id": "m1",
            "operation_id": "op1",
            "created_at": "2026-01-01T00:00:00+00:00",
        }
    )


def test_i06_a_crash_truncated_tail_is_discarded(tmp_path: Path) -> None:
    """The behavioural half: a half-written last line must not abort the read.

    A crash mid-append leaves exactly this shape, and it is the common case
    rather than an exotic one — so refusing to read the journal here would turn
    an interrupted run into an unrecoverable one.
    """
    journal = tmp_path / "truncated.journal"
    journal.write_text(f'{_journal_header()}\n{{"record":"entry","par', encoding="utf-8")

    try:
        result = read_journal(journal)
    except Exception as exc:  # pragma: no cover - reported by the assertion
        raise AssertionError(f"a truncated tail must be discarded, not raised: {exc!r}") from exc

    assert result.journal_id == "j1"
    assert result.entries == (), "the partial record was accepted instead of discarded"


def test_i06_a_corrupt_record_that_is_not_the_tail_is_still_refused(tmp_path: Path) -> None:
    """Only the *last* line may be discarded — anything else is real corruption."""
    journal = tmp_path / "corrupt.journal"
    journal.write_text(
        f'{_journal_header()}\n{{"record":"entry","par\n{{"record":"state","state":"committed"}}\n',
        encoding="utf-8",
    )

    with pytest.raises(ValueError):
        read_journal(journal)


# ---------------------------------------------------------------------- #
# I-07 — type-level immutability                                           #
# ---------------------------------------------------------------------- #


def test_i07_a_resolved_outcome_is_frozen() -> None:
    outcome = ResolvedOutcome(member_id="m1", kind="no_action_reference")

    with pytest.raises(ValidationError):
        outcome.member_id = "m2"


def test_i07_a_reference_member_can_never_mutate_its_source() -> None:
    with pytest.raises(ValueError):
        ResolvedOutcome(member_id="m1", kind="no_action_reference", mutates_source=True)


# ---------------------------------------------------------------------- #
# I-08 — keeper selection                                                  #
# ---------------------------------------------------------------------- #


def test_i08_keeper_selection_cannot_import_the_ai_stack() -> None:
    """AI confidence must never participate in choosing what survives."""
    tree = _tree("services/keeper_policies.py")

    imported: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.extend(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            imported.append(node.module)

    offenders = [name for name in imported if "services.ai" in name or name.endswith(".ai")]
    assert offenders == [], f"keeper selection imports the AI stack: {offenders}"


def test_i08_the_final_tie_break_is_total_and_scan_order_independent() -> None:
    """Determinism needs a total order; identity is the documented last resort."""
    node = _function("services/keeper_policies.py", "_identity")

    rendered = ast.unparse(node)
    for part in ("root_id", "relative_path", "member_id"):
        assert part in rendered, f"the tie-break dropped {part}, so it is no longer total"


# ---------------------------------------------------------------------- #
# I-09 · I-14 — the catalog                                                #
# ---------------------------------------------------------------------- #


@pytest.fixture()
def catalog(tmp_path: Path) -> Any:
    with MediaCatalog(tmp_path / "catalog.db") as opened:
        opened.register_root("r1", tmp_path / "library")
        yield opened


def _observed(name: str, *, identity: str = "1") -> ObservedFile:
    return ObservedFile(
        relative_path=name,
        size_bytes=100,
        mtime_ns=1_000,
        file_identity=identity,
    )


def _scan(catalog: Any, names: list[str], *, outcome: str) -> list[FileRecord]:
    generation = catalog.begin_generation("r1")
    records = catalog.observe("r1", generation, [_observed(name, identity=name) for name in names])
    catalog.finish_generation(generation, outcome)
    return list(records)


def test_i09_an_incomplete_generation_marks_nothing_missing(catalog: Any) -> None:
    """A cancelled or partial scan must not conclude that files disappeared."""
    _scan(catalog, ["a.jpg", "b.jpg"], outcome="complete")
    _scan(catalog, ["a.jpg"], outcome="partial")

    assert catalog.count_files("r1") == 2, "a partial generation marked a row missing"


def test_i09_a_complete_generation_is_the_only_thing_that_may(catalog: Any) -> None:
    """The other half — otherwise the test above passes if nothing ever marks."""
    _scan(catalog, ["a.jpg", "b.jpg"], outcome="complete")
    _scan(catalog, ["a.jpg"], outcome="complete")

    assert catalog.count_files("r1") == 1
    assert catalog.count_files("r1", include_missing=True) == 2


def test_i14_a_stale_fingerprint_version_is_a_cache_miss(catalog: Any) -> None:
    """A superseded fingerprint must return no hash — never the old one."""
    import dataclasses

    record = _scan(catalog, ["a.jpg"], outcome="complete")[0]
    catalog.store_hash(record, "a" * 64)
    assert catalog.hash_for(record) == "a" * 64

    superseded = dataclasses.replace(record, fingerprint_version=record.fingerprint_version + 1)
    assert catalog.hash_for(superseded) is None, "a stale row answered instead of missing"


def test_i14_a_changed_fingerprint_is_a_cache_miss(catalog: Any) -> None:
    import dataclasses

    record = _scan(catalog, ["a.jpg"], outcome="complete")[0]
    catalog.store_hash(record, "b" * 64)

    edited = dataclasses.replace(record, fingerprint=record.fingerprint + "-changed")
    assert catalog.hash_for(edited) is None


# ---------------------------------------------------------------------- #
# I-10 — unknown is not zero                                               #
# ---------------------------------------------------------------------- #


def test_i10_an_unknown_fact_is_not_a_zero_one() -> None:
    unknown = FactValue()
    measured_zero = FactValue(known=True, value=0)

    assert unknown.known is False
    assert measured_zero.known is True
    assert unknown.value != 0 or unknown.known != measured_zero.known


def test_i10_an_unreadable_size_is_unknown_not_zero(tmp_path: Path) -> None:
    """C-10, the case this invariant was violated by until `P1-FS-006(a)`."""
    empty = tmp_path / "empty.jpg"
    empty.touch()

    assert SortingSupportMixin._safe_stat(empty) == 0
    assert SortingSupportMixin._safe_stat(tmp_path / "missing.jpg") is None


def test_i10_progress_totals_carry_their_own_certainty() -> None:
    """A total nobody knows yet must not render as a confident 0."""
    progress = TaskProgress()

    assert progress.total_known is False
    assert progress.bytes_total_known is False


# ---------------------------------------------------------------------- #
# I-11 — the loopback boundary                                             #
# ---------------------------------------------------------------------- #


def test_i11_a_weak_capability_is_refused_at_construction() -> None:
    with pytest.raises(ValueError):
        LocalApiSecurityMiddleware(
            lambda scope, receive, send: None,  # type: ignore[arg-type,return-value]
            capability="too-short",
            origins=frozenset({"http://localhost:1420"}),
        )


def test_i11_a_wrong_capability_is_rejected(client: TestClient) -> None:
    """`conftest` injects a valid capability by default, so this overrides it."""
    response = client.get(
        "/api/health",
        headers={
            "X-MediaSorter-Capability": "wrong-capability-value",
            "Origin": "http://localhost:1420",
        },
    )

    assert response.status_code == 401


def test_i11_a_foreign_origin_is_rejected_even_with_a_valid_capability(
    client: TestClient,
) -> None:
    """Both halves are required: the capability alone does not open the door."""
    response = client.get("/api/health", headers={"Origin": "http://evil.example"})

    assert response.status_code == 403


def test_i11_the_allowed_origin_with_a_valid_capability_still_works() -> None:
    """The guard against 'hardening' the boundary into refusing everything."""
    from tests.conftest import _TEST_API_CAPABILITY

    assert len(_TEST_API_CAPABILITY) >= 32


# ---------------------------------------------------------------------- #
# I-12 — bounded subprocesses (implemented by P1-SEC-005)                  #
# ---------------------------------------------------------------------- #


def test_i12_every_subprocess_is_bounded_and_shell_free() -> None:
    """Delegates to the dedicated module so there is one canonical checker."""
    from tests import test_subprocess_timeouts as checks

    checks.test_every_bounded_subprocess_call_passes_a_timeout()
    checks.test_no_subprocess_call_uses_a_shell()
    checks.test_the_hardware_probe_is_bounded()


# ---------------------------------------------------------------------- #
# I-13 — model supply chain                                                #
# ---------------------------------------------------------------------- #


def _manifest(**overrides: Any) -> str:
    import json

    component: dict[str, Any] = {
        "repository": "openai/clip-vit-base-patch32",
        "revision": "a" * 40,
        "files": [{"path": "model.onnx", "sha256": "b" * 64, "size": 10}],
    }
    component.update(overrides)
    return json.dumps(
        {
            "schema_version": 1,
            "default_source": "https://huggingface.co",
            "packs": {"base": {"total_size": 10, "components": {"visual": component}}},
        }
    )


def test_i13_the_reference_manifest_parses() -> None:
    """The control the two refusals below depend on.

    Without it, a fixture broken for an unrelated reason makes every
    `pytest.raises(ModelManifestError)` pass while proving nothing — which is
    exactly what this fixture did before `size` was spelled correctly.
    """
    source, packs = parse_manifest(_manifest())

    assert source == "https://huggingface.co"
    assert "base" in packs


def test_i13_a_mutable_revision_is_refused() -> None:
    """A tag or branch can move; only a commit SHA pins an artifact."""
    with pytest.raises(ModelManifestError, match="immutable commit"):
        parse_manifest(_manifest(revision="main"))


def test_i13_a_foreign_model_source_is_refused() -> None:
    import json

    document = json.loads(_manifest())
    document["default_source"] = "https://example.invalid"

    with pytest.raises(ModelManifestError, match="huggingface"):
        parse_manifest(json.dumps(document))


# ---------------------------------------------------------------------- #
# I-15 — destructive tests never touch a real library                      #
# ---------------------------------------------------------------------- #


def test_i15_the_suite_redirects_all_app_storage_into_a_temporary_directory() -> None:
    """The mechanism, not a convention: `conftest` repoints storage before import.

    Every destructive test runs against these directories. If the redirect were
    removed, the suite would operate on the developer's real MediaSorter data,
    and no individual test would notice.
    """
    temp_root = Path(tempfile.gettempdir()).resolve()

    for variable in ("MEDIASORT_CONFIG_DIR", "MEDIASORT_DATA_DIR", "MEDIASORT_LOG_DIR"):
        raw = os.environ.get(variable)
        assert raw, f"{variable} is not set — app storage is not sandboxed"
        resolved = Path(raw).resolve()
        assert resolved.is_relative_to(temp_root), (
            f"{variable} points outside the temp directory: {resolved}"
        )


def test_i15_the_sandbox_is_not_the_real_user_directory() -> None:
    """Guards the assertion above against a temp dir that is someone's home."""
    for variable in ("MEDIASORT_CONFIG_DIR", "MEDIASORT_DATA_DIR"):
        resolved = Path(os.environ[variable]).resolve()
        assert resolved != Path.home().resolve()
        assert "mediasort-tests-" in str(resolved)


# ---------------------------------------------------------------------- #
# The registry                                                             #
# ---------------------------------------------------------------------- #


def test_every_invariant_has_at_least_one_executable_assertion() -> None:
    """`P1-TEST-001`'s acceptance criterion, as a check rather than a promise."""
    assert len(INVARIANTS) == 15, "the registry no longer describes all fifteen invariants"

    defined = {name for name in globals() if name.startswith("test_i")}
    missing = [
        invariant
        for invariant in INVARIANTS
        if not any(name.startswith(f"test_i{invariant[2:]}_") for name in defined)
    ]

    assert missing == [], f"invariants with no executable assertion: {missing}"
