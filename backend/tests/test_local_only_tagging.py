"""D-06 — a photograph cannot leave the machine, because nothing can send it.

The earlier design posted the user's picture to Azure, Imagga or Google and
guarded that with a recorded consent. A gate is a promise that some code checked
a flag; removing the uploaders is a property of the build. These tests assert the
stronger thing: there is no cloud tagger, and the AI package holds no HTTP client
to become one by accident.

They are deliberately structural rather than behavioural. A behavioural test can
only prove that the paths it thought to call refuse; walking the package proves
that no path exists at all, including ones a future edit adds.
"""

from __future__ import annotations

import ast
import pkgutil
from pathlib import Path

import pytest

import app.services.ai as ai_pkg
from app.core.config import RETIRED_CONFIG_KEYS, Config, coerce_config_update
from app.services.ai import base_tagger

#: Retired when the cloud taggers were removed. A stored config may still carry
#: any of these; none may come back as a live field.
RETIRED_CLOUD_KEYS = (
    "ai_tagging_provider",
    "ai_tagging_api_key",
    "ai_tagging_api_secret",
    "ai_tagging_endpoint",
)

#: Modules that may legitimately speak HTTP: downloading a *model* is not
#: uploading a *photograph*. Everything else in the package must not.
_MODEL_DOWNLOAD_MODULES = {"model_installation", "model_manifest"}

_NETWORK_MODULES = {"httpx", "requests", "urllib", "urllib3", "http", "aiohttp", "socket"}


def _ai_module_paths() -> list[tuple[str, Path]]:
    root = Path(ai_pkg.__file__).parent
    return [
        (info.name, root / f"{info.name}.py")
        for info in pkgutil.iter_modules([str(root)])
        if (root / f"{info.name}.py").exists()
    ]


def _imported_roots(path: Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    roots: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            roots.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            roots.add(node.module.split(".")[0])
    return roots


class TestNoCloudTaggerExists:
    @pytest.mark.parametrize(
        "name",
        ["AzureVisionTagger", "ImaggaTagger", "GoogleCloudVisionTagger", "CloudConsent"],
    )
    def test_removed_symbol_is_gone(self, name: str) -> None:
        assert not hasattr(base_tagger, name), f"{name} is back; tagging must stay local-only"

    def test_local_tagger_is_the_only_concrete_tagger(self) -> None:
        concrete = {
            name
            for name, obj in vars(base_tagger).items()
            if isinstance(obj, type)
            and issubclass(obj, base_tagger.AITagger)
            and obj is not base_tagger.AITagger
            and not getattr(obj, "__abstractmethods__", None)
        }
        assert concrete == {"LocalClipTagger"}

    def test_tagger_module_has_no_http_client(self) -> None:
        assert not (_imported_roots(Path(base_tagger.__file__)) & _NETWORK_MODULES)


class TestAiPackageDoesNotUpload:
    def test_no_inference_module_imports_a_network_client(self) -> None:
        offenders = {
            name: sorted(_imported_roots(path) & _NETWORK_MODULES)
            for name, path in _ai_module_paths()
            if name not in _MODEL_DOWNLOAD_MODULES
        }
        assert {n: v for n, v in offenders.items() if v} == {}


class TestBuildTaggerIsLocalOnly:
    def test_disabled_returns_none(self) -> None:
        assert base_tagger.build_tagger(Config(ai_tagging_enabled=False), embedder=object()) is None  # type: ignore[arg-type]

    def test_enabled_without_encoder_returns_none(self) -> None:
        assert base_tagger.build_tagger(Config(ai_tagging_enabled=True), embedder=None) is None


class TestRetiredCloudConfigKeys:
    @pytest.mark.parametrize("key", RETIRED_CLOUD_KEYS)
    def test_key_is_retired(self, key: str) -> None:
        assert key in RETIRED_CONFIG_KEYS

    @pytest.mark.parametrize("key", RETIRED_CLOUD_KEYS)
    def test_key_is_not_a_live_field(self, key: str) -> None:
        assert not hasattr(Config(), key)

    @pytest.mark.parametrize("key", RETIRED_CLOUD_KEYS)
    def test_stored_config_carrying_the_key_still_loads(self, key: str) -> None:
        config = Config.from_dict({key: "left over from an older install"})
        assert not hasattr(config, key)

    @pytest.mark.parametrize("key", RETIRED_CLOUD_KEYS)
    def test_update_carrying_the_key_is_ignored_not_rejected(self, key: str) -> None:
        coerced, errors = coerce_config_update({key: "anything"})
        assert errors == []
        assert key not in coerced
