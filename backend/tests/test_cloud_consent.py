"""D-06 — a photograph does not leave the machine without a recorded decision.

Three taggers post the user's picture to a third party. None of them asked
anything first, and nothing recorded which provider had seen it. The gate is on
the taggers rather than on a caller because there is no caller: nothing in
`app/` constructs these classes today, so a gate in a call site would be a gate
in a file that does not exist yet.
"""

from __future__ import annotations

from typing import Any

import httpx
import pytest
from PIL import Image

from app.core.provenance import CategorizationProvenance
from app.services.ai.base_tagger import (
    AzureVisionTagger,
    CloudConsent,
    GoogleCloudVisionTagger,
    ImaggaTagger,
)

CLOUD_TAGGERS = (
    ("azure-vision", lambda consent: AzureVisionTagger("https://azure", "key", consent=consent)),
    ("imagga", lambda consent: ImaggaTagger("key", "secret", consent=consent)),
    (
        "google-cloud-vision",
        lambda consent: GoogleCloudVisionTagger("key", consent=consent),
    ),
)


@pytest.fixture
def image() -> Image.Image:
    return Image.new("RGB", (8, 8), color=(10, 20, 30))


@pytest.fixture(autouse=True)
def attempts(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Records every upload the tagger tries.

    Recording rather than raising: these taggers catch broadly and turn any
    exception into a warning, so an exception-based probe would be swallowed and
    the test would pass whether or not the request had been made.
    """
    made: list[str] = []

    def record(*args: Any, **kwargs: Any) -> Any:
        made.append(str(args[0]) if args else "post")
        raise httpx.ConnectError("no network in tests")

    monkeypatch.setattr("app.services.ai.base_tagger.httpx.post", record)
    return made


class TestNothingUploadsWithoutConsent:
    @pytest.mark.parametrize(("provider", "build"), CLOUD_TAGGERS)
    def test_no_consent_means_no_request(
        self, provider: str, build: Any, image: Image.Image, attempts: list[str]
    ) -> None:
        tagger = build(None)

        assert tagger.tag(image) == []
        assert attempts == []
        assert any("no recorded consent" in warning for warning in tagger.warnings)

    @pytest.mark.parametrize(("provider", "build"), CLOUD_TAGGERS)
    def test_consent_for_another_provider_is_not_consent(
        self, provider: str, build: Any, image: Image.Image, attempts: list[str]
    ) -> None:
        """Agreeing to one company is not agreeing to a different one."""
        elsewhere = CloudConsent(provider="somebody-else", consented_at="2026-08-20T00:00:00Z")

        assert build(elsewhere).tag(image) == []
        assert attempts == []

    @pytest.mark.parametrize(("provider", "build"), CLOUD_TAGGERS)
    def test_a_flag_without_a_record_is_not_consent(
        self, provider: str, build: Any, image: Image.Image, attempts: list[str]
    ) -> None:
        """Named but never agreed to — the shape a boolean would have allowed."""
        unrecorded = CloudConsent(provider=provider, consented_at="")

        assert build(unrecorded).tag(image) == []
        assert attempts == []

    @pytest.mark.parametrize(("provider", "build"), CLOUD_TAGGERS)
    def test_matching_consent_lets_the_request_be_attempted(
        self, provider: str, build: Any, image: Image.Image, attempts: list[str]
    ) -> None:
        """The control: the gate must be a gate, not a wall. With consent the
        tagger proceeds far enough to attempt the call — which the fixture turns
        into the assertion error, proving the guard was the only thing stopping
        it."""
        granted = CloudConsent(provider=provider, consented_at="2026-08-20T00:00:00Z")

        assert build(granted).tag(image) == []
        assert attempts, "consent was recorded and still nothing was attempted"


class TestProvenanceRecordsTheProvider:
    def test_a_local_decision_can_say_so(self) -> None:
        record = CategorizationProvenance(enabled=True, label="beach", provider="local")

        assert record.provider == "local"

    def test_a_cloud_decision_can_name_the_company(self) -> None:
        record = CategorizationProvenance(enabled=True, label="beach", provider="azure-vision")

        assert record.provider == "azure-vision"

    def test_the_field_defaults_to_unknown_rather_than_local(self) -> None:
        """Defaulting to `"local"` would let an unrecorded cloud call look
        on-device. Unknown is the honest default."""
        assert CategorizationProvenance(enabled=False).provider is None
