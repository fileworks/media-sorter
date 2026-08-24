"""Static checks for the supported GitHub Actions baseline."""

import itertools
import json
import re
from pathlib import Path

import yaml

ROOT = Path(__file__).parents[2]
WORKFLOWS = ROOT / ".github" / "workflows"


def _matrix_rows(matrix: object) -> list[dict[str, object]]:
    """Every combination a matrix expands to, `include` rows taken verbatim."""
    if not isinstance(matrix, dict):
        return [{}]
    included = matrix.get("include")
    if isinstance(included, list):
        return [row for row in included if isinstance(row, dict)]
    axes = {
        str(key): value
        for key, value in matrix.items()
        if key not in {"include", "exclude"} and isinstance(value, list)
    }
    if not axes:
        return [{}]
    return [dict(zip(axes, values, strict=True)) for values in itertools.product(*axes.values())]


def _emitted_contexts(document: object) -> set[str]:
    """The exact check names this workflow reports, matrices expanded."""
    contexts: set[str] = set()
    assert isinstance(document, dict)
    jobs = document.get("jobs")
    assert isinstance(jobs, dict)
    for job_id, raw_job in jobs.items():
        assert isinstance(raw_job, dict)
        template = str(raw_job.get("name") or job_id)
        strategy = raw_job.get("strategy")
        matrix = strategy.get("matrix") if isinstance(strategy, dict) else None
        for row in _matrix_rows(matrix):
            context = template
            for key, value in row.items():
                context = context.replace(f"${{{{ matrix.{key} }}}}", str(value))
            assert "${{ matrix." not in context, f"unresolved context template: {context}"
            contexts.add(context)
    return contexts


def _assert_workflow_policy(source: str, policy: dict[str, object]) -> None:
    required = policy["required_contexts"]
    assert isinstance(required, list)
    assert _emitted_contexts(yaml.safe_load(source)) == {str(name) for name in required}
    native = source.split("  native:", maxsplit=1)[1].split("\n  docs-links:", maxsplit=1)[0]
    command = str(policy["native_clippy_command"])
    assert native.count(command) == 1


def _workflow_text() -> str:
    return "\n".join(path.read_text(encoding="utf-8") for path in sorted(WORKFLOWS.glob("*.yml")))


def test_official_actions_use_node_24_compatible_generations() -> None:
    workflows = _workflow_text()

    approved = {
        "actions/cache": {"v6"},
        "actions/checkout": {"v5", "v7"},
        "actions/setup-python": {"v7"},
        "actions/upload-artifact": {"v7"},
        "actions/setup-node": {"v7"},
        "actions/download-artifact": {"v8"},
    }
    for action, versions in approved.items():
        observed = set(re.findall(rf"{re.escape(action)}@([^\s]+)", workflows))
        assert observed
        assert observed <= versions


def test_all_explicit_node_toolchains_use_node_24() -> None:
    """Every `setup-node` step pins Node 24 — asserted per step, not by counting.

    This used to assert a literal step count, which made adding any job that
    needs Node fail a test about Node *versions*. The count was a proxy for the
    real rule and a worse one: it says nothing about a step that pins the wrong
    version, and it has to be edited every time the workflows grow.
    """
    pinned: list[tuple[str, str, str | None]] = []
    for path in sorted(WORKFLOWS.glob("*.yml")):
        document = yaml.safe_load(path.read_text(encoding="utf-8"))
        for job_name, job in (document.get("jobs") or {}).items():
            for step in job.get("steps") or []:
                uses = str(step.get("uses") or "")
                if not uses.startswith("actions/setup-node"):
                    continue
                version = (step.get("with") or {}).get("node-version")
                pinned.append((path.name, job_name, None if version is None else str(version)))

    assert pinned, "no setup-node step found; this test would pass vacuously"
    wrong = [entry for entry in pinned if entry[2] != "24"]
    assert wrong == [], f"setup-node steps not pinned to Node 24: {wrong}"

    workflows = _workflow_text()
    assert "Set up Node 20" not in workflows
    assert 'node-version: "20"' not in workflows


def test_manual_release_validation_cannot_publish_without_a_tag() -> None:
    release = (WORKFLOWS / "release.yml").read_text(encoding="utf-8")

    assert "workflow_dispatch:" in release
    assert "if: startsWith(github.ref, 'refs/tags/v')" in release


def test_msi_smoke_resolves_the_installer_created_shortcut_target() -> None:
    release = (WORKFLOWS / "release.yml").read_text(encoding="utf-8")
    smoke = release.split(
        "      - name: Install, launch, and uninstall MSI on a clean Windows runner",
        maxsplit=1,
    )[1].split(
        "      - name: Install, launch, and uninstall NSIS on a clean Windows runner",
        maxsplit=1,
    )[0]

    assert "[Environment+SpecialFolder]::CommonPrograms" in smoke
    assert 'Get-ChildItem $programs -Filter "MediaSorter.lnk" -Recurse -File' in smoke
    assert "CreateShortcut($shortcut.FullName).TargetPath" in smoke
    assert '[IO.Path]::GetExtension($shell) -ine ".exe"' in smoke
    assert "Test-Path -LiteralPath $shell -PathType Leaf" in smoke
    assert "if (Test-Path -LiteralPath $shell)" in smoke
    assert "GetFileName($shell)" not in smoke
    assert "Windows\\CurrentVersion\\Uninstall\\*" not in smoke
    assert "$env:ProgramFiles\\MediaSorter\\MediaSorter.exe" not in smoke


def test_nsis_smoke_resolves_the_installer_created_shortcut_target() -> None:
    release = (WORKFLOWS / "release.yml").read_text(encoding="utf-8")
    smoke = release.split(
        "      - name: Install, launch, and uninstall NSIS on a clean Windows runner",
        maxsplit=1,
    )[1].split("\n      - name: Upload artifacts", maxsplit=1)[0]

    assert "[Environment+SpecialFolder]::Programs" in smoke
    assert "[Environment+SpecialFolder]::CommonPrograms" in smoke
    assert 'Get-ChildItem $programs -Filter "MediaSorter.lnk" -Recurse -File' in smoke
    assert "CreateShortcut($shortcut.FullName).TargetPath" in smoke
    assert '[IO.Path]::GetExtension($shell) -ine ".exe"' in smoke
    assert "Test-Path -LiteralPath $shell -PathType Leaf" in smoke
    assert "if (Test-Path -LiteralPath $shell)" in smoke
    assert "GetFileName($shell)" not in smoke
    assert "$env:ProgramFiles\\MediaSorter\\MediaSorter.exe" not in smoke
    assert "$env:LOCALAPPDATA\\MediaSorter\\MediaSorter.exe" not in smoke


def test_green_tag_pipeline_publishes_through_the_release_environment() -> None:
    release = (WORKFLOWS / "release.yml").read_text(encoding="utf-8")
    publish = release.split("  publish:", maxsplit=1)[1]

    assert "environment: github-release" in publish
    assert "draft: false" in publish
    assert "publish_release" not in release
    assert "smoke_evidence" not in release


def test_release_native_gate_runs_on_a_shipped_platform() -> None:
    release = (WORKFLOWS / "release.yml").read_text(encoding="utf-8")

    native_gate = release.split("  check-native:", maxsplit=1)[1].split("\n  package:", maxsplit=1)[
        0
    ]
    assert "runs-on: macos-latest" in native_gate
    assert "cargo check --locked" in native_gate
    assert "cargo test --locked" in native_gate
    assert "cargo clippy --locked -- -D warnings" in native_gate
    assert "components: rustfmt, clippy" in native_gate
    assert "needs: [check-ci, check-native]" in release


def test_release_ref_is_verified_before_any_packaging_job_can_run() -> None:
    release = (WORKFLOWS / "release.yml").read_text(encoding="utf-8")
    source_gate = release.split("  check-ci:", maxsplit=1)[1].split(
        "\n  check-native:", maxsplit=1
    )[0]

    assert "fetch-depth: 0" in source_gate
    assert "node --test scripts/releaseability.test.cjs" in source_gate
    assert "node scripts/releaseability.cjs --verify-tag" in source_gate
    assert "npm ci --ignore-scripts" in source_gate
    assert source_gate.index("npm ci --ignore-scripts") < source_gate.index(
        "node scripts/releaseability.cjs --verify-tag"
    )
    assert "needs: [check-ci, check-native]" in release


def test_native_ci_denies_clippy_warnings() -> None:
    workflow = (WORKFLOWS / "ci.yml").read_text(encoding="utf-8")
    native = workflow.split("  native:", maxsplit=1)[1].split("\n  docs-links:", maxsplit=1)[0]

    assert native.count("cargo clippy --locked -- -D warnings") == 1
    assert "components: rustfmt, clippy" in native
    assert "Canonical command: maintenance/workflows.py" in native


def test_ci_emits_every_exact_generated_policy_context() -> None:
    workflow = (WORKFLOWS / "ci.yml").read_text(encoding="utf-8")
    policy = json.loads((ROOT / "contracts" / "workflow-policy.json").read_text(encoding="utf-8"))

    _assert_workflow_policy(workflow, policy)


def test_workflow_policy_guard_detects_context_and_clippy_mutations() -> None:
    workflow = (WORKFLOWS / "ci.yml").read_text(encoding="utf-8")
    policy = json.loads((ROOT / "contracts" / "workflow-policy.json").read_text(encoding="utf-8"))
    mutations = (
        workflow.replace("name: build", "name: build-renamed", 1),
        workflow.replace(str(policy["native_clippy_command"]), "cargo clippy --locked", 1),
    )

    for mutated in mutations:
        try:
            _assert_workflow_policy(mutated, policy)
        except AssertionError:
            continue
        raise AssertionError("workflow policy mutation was not detected")


def test_active_media_tagging_documentation_is_uniformly_local_only() -> None:
    required_claims = {
        ROOT / "README.md": "no cloud media provider or credential path",
        ROOT / "SECURITY.md": "stores no cloud media credentials",
        ROOT / "docs" / "design.md": "there is no cloud tagger",
        ROOT / "docs" / "settings-reference.md": "local-only",
        ROOT / "docs" / "kb-api-contract.md": "Never add credentials or media-provider secrets",
        ROOT / "docs" / "kb-backend.md": "Never add cloud media providers or credential fields",
        ROOT / "docs" / "kb-testing.md": "there is no cloud media tagger",
    }

    missing = {
        str(path.relative_to(ROOT)): claim
        for path, claim in required_claims.items()
        if claim not in path.read_text(encoding="utf-8")
    }
    assert missing == {}


def test_release_retries_transient_tauri_bundler_download_failures() -> None:
    release = (WORKFLOWS / "release.yml").read_text(encoding="utf-8")
    build_step = release.split("      - name: Build desktop app", maxsplit=1)[1].split(
        "      - name: Reject post-sign payload mutation", maxsplit=1
    )[0]

    assert "for attempt in 1 2 3" in build_step
    assert "if make build-tauri; then" in build_step
    assert 'if [ "$attempt" -eq 3 ]; then' in build_step
    assert "Tauri bundling retry" in build_step


def test_frozen_backend_bundles_runtime_resources() -> None:
    makefile = (ROOT / "Makefile").read_text(encoding="utf-8")
    release = (WORKFLOWS / "release.yml").read_text(encoding="utf-8")
    tauri = json.loads(
        (ROOT / "frontend" / "src-tauri" / "tauri.conf.json").read_text(encoding="utf-8")
    )

    assert "--collect-all=app.resources" in makefile
    assert "bundle-clip" not in makefile
    assert "bundle-clip" not in release
    # A recursive resources glob is correct here, and the previous assertion that it must be
    # absent is what broke four releases.
    #
    # It was split into `resources/backend/**` + `resources/ffmpeg/**` to keep
    # on-demand AI model packs out of the installer. But packs never live here:
    # ModelInstaller roots them at `resolve_app_paths().data_dir / "ai-models"`,
    # a PlatformDirs location written at runtime, so no glob over the source tree
    # can pick them up.
    #
    # The split cost two things. `resources/ffmpeg/**` matched nothing, because
    # fetch_ffmpeg writes three flat files and `**` needs a directory to descend
    # into. And splitting changed the bundled layout, so the backend landed
    # somewhere other than Contents/Resources/resources/backend/ and packaging
    # verification failed on a missing artifact.
    assert tauri["bundle"]["resources"] == ["resources/**/*"]


def test_model_packs_are_never_bundled_into_the_installer() -> None:
    """The reason a recursive resources glob is safe, asserted rather than assumed.

    Packs are rooted at the PlatformDirs data directory and written at runtime,
    so no glob over the source tree can sweep them into the bundle. If that ever
    changes, the recursive resources glob stops being safe and this fails first.
    """
    installer = (ROOT / "backend" / "app" / "services" / "ai" / "model_installation.py").read_text(
        encoding="utf-8"
    )

    assert 'MODEL_ROOT_NAME = "ai-models"' in installer
    assert "resolve_app_paths().data_dir / MODEL_ROOT_NAME" in installer
    assert "src-tauri" not in installer


def test_every_bundled_resource_glob_matches_something() -> None:
    """A declared glob that matches nothing aborts the Tauri build.

    `resources/ffmpeg/**` matched nothing and stranded four tags with no
    installers: `fetch_ffmpeg` writes three flat files and no directory, so a
    trailing `**` had nothing to descend into. `resources/backend/**` was fine
    only because that tree happens to contain a subdirectory.

    Tauri v2 requires the trailing `*` in `resources/**/*` to include files at
    every depth, so the glob has to be right rather than merely broad.
    """
    config = json.loads(
        (ROOT / "frontend" / "src-tauri" / "tauri.conf.json").read_text(encoding="utf-8")
    )
    tauri_root = ROOT / "frontend" / "src-tauri"

    for pattern in config["bundle"]["resources"]:
        static_prefix = pattern.split("*", maxsplit=1)[0].rstrip("/")
        target = tauri_root / static_prefix
        if not target.is_dir():
            continue  # not built in this checkout; the release job builds it
        assert any(path.is_file() for path in tauri_root.glob(pattern)), (
            f"{pattern} matches no files"
        )


def test_the_windows_only_contracts_run_on_a_windows_runner() -> None:
    """P2-TEST-002. Three contracts are `skipif` non-Windows, so the only place
    they can ever execute is the Windows job — and `test_root_identity.py` was
    not in its file list, which meant they were skipped everywhere and run
    nowhere. A skip is never a pass."""
    workflow = yaml.safe_load((ROOT / ".github" / "workflows" / "ci.yml").read_text("utf-8"))
    windows = workflow["jobs"]["backend-windows"]
    invocation = " ".join(str(step.get("run", "")) for step in windows["steps"] if "run" in step)

    assert "windows" in str(windows["runs-on"])
    for module in (
        "tests/test_utils/test_path_utils.py",
        "tests/test_root_identity.py",
    ):
        assert module in invocation, module


def test_the_transfer_suites_also_run_on_apfs() -> None:
    """The same argument in the other direction: APFS is case-insensitive and
    stores names decomposed, so proving the transfer and identity rules only on
    the Linux runner proves them for a filesystem no user has."""
    workflow = yaml.safe_load((ROOT / ".github" / "workflows" / "ci.yml").read_text("utf-8"))
    macos = workflow["jobs"]["backend-macos"]
    invocation = " ".join(str(step.get("run", "")) for step in macos["steps"] if "run" in step)

    assert "macos" in str(macos["runs-on"])
    for module in (
        "tests/test_verified_transfer.py",
        "tests/test_transfer_end_to_end.py",
        "tests/test_path_identity.py",
    ):
        assert module in invocation, module


def test_every_windows_only_test_lives_in_a_module_the_windows_job_runs() -> None:
    """The rule rather than today's list: a new `skipif(win32)` contract added
    to a module CI does not run would be invisible in exactly the same way."""
    workflow = yaml.safe_load((ROOT / ".github" / "workflows" / "ci.yml").read_text("utf-8"))
    invocation = " ".join(
        str(step.get("run", ""))
        for step in workflow["jobs"]["backend-windows"]["steps"]
        if "run" in step
    )

    unrun: list[str] = []
    scanner = Path(__file__).name
    for path in sorted((ROOT / "backend" / "tests").rglob("test_*.py")):
        if path.name == scanner:
            # This module names those markers in the line just below, and a
            # scanner that reports itself reports nothing useful.
            continue
        # A *marker*, not a bare substring: this file names those expressions
        # in its own detection logic and would otherwise report itself.
        windows_only = any(
            "skipif" in line and ('!= "win32"' in line or '!= "nt"' in line)
            for line in path.read_text(encoding="utf-8").splitlines()
        )
        if not windows_only:
            continue
        relative = path.relative_to(ROOT / "backend").as_posix()
        if relative not in invocation:
            unrun.append(relative)

    assert unrun == [], f"windows-only contracts in modules the Windows job never runs: {unrun}"


def test_the_release_attests_provenance_with_minimal_permissions() -> None:
    """P2-SEC-002 / DEC-02. Attestations are an integrity anchor for an app that
    stays unsigned. The grant that mints them is OIDC, so it belongs to exactly
    one job and no other."""
    workflow = yaml.safe_load((ROOT / ".github" / "workflows" / "release.yml").read_text("utf-8"))
    publish = workflow["jobs"]["publish"]

    assert publish["permissions"] == {
        "contents": "write",
        "id-token": "write",
        "attestations": "write",
    }
    attests = [
        step for step in publish["steps"] if "attest-build-provenance" in str(step.get("uses", ""))
    ]
    assert len(attests) == 1
    subjects = str(attests[0]["with"]["subject-path"])
    for extension in (".dmg", ".msi", ".exe", ".zip"):
        assert extension in subjects, extension

    # The mint must not be handed to any other job in the file.
    for name, job in workflow["jobs"].items():
        if name == "publish":
            continue
        assert "id-token" not in (job.get("permissions") or {}), name


def test_the_docs_refuse_to_call_attestations_signing() -> None:
    """DEC-02's third acceptance. An unnotarized DMG is *blocked* by default on
    current macOS; a release note implying provenance fixes that would be
    telling users something false about their own machine."""
    signing = (ROOT / "docs" / "release-signing.md").read_text(encoding="utf-8").lower()

    assert "attestation" in signing
    assert "not code signing" in signing or "are not signing" in signing
    assert "gh attestation verify" in signing
    assert "notariz" in signing
