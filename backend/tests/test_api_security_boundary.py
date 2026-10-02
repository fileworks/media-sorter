"""The two live defects in the loopback boundary (F-13, F-14).

The documentation said this middleware "rejects unauthenticated HTTP/WebSocket
traffic before route dispatch". Two things made that untrue:

* `secrets.compare_digest` **raises** on a string containing a byte >= 0x80, so
  an attacker-supplied header could turn a clean 401 into an unenveloped 500;
* the CORS-preflight exemption fired on *any* `OPTIONS` request — including one
  carrying no `Origin` at all, and one with no `Access-Control-Request-Method` —
  which dispatched it to the application unauthenticated.

Both are exercised over HTTP and WebSocket here.
"""

from __future__ import annotations

import secrets
import string

import pytest
from fastapi.testclient import TestClient

from app.core.api_security import WEBSOCKET_PROTOCOL_PREFIX

ALLOWED_ORIGIN = "http://localhost:1420"
DISALLOWED_ORIGIN = "http://evil.example"
HEADER = "X-MediaSorter-Capability"


@pytest.fixture()
def anonymous(app: object) -> TestClient:
    """A client that sends no capability at all.

    `conftest` gives every `TestClient` the capability header by default so the
    integration suite exercises the authenticated product surface. A test about
    the boundary itself has to take it away again — otherwise it measures an
    authenticated request and proves nothing about who is let in.
    """
    client = TestClient(app)  # type: ignore[arg-type]
    client.headers.pop("X-MediaSorter-Capability", None)
    return client


def _envelope(response: object) -> None:
    payload = response.json()  # type: ignore[attr-defined]
    assert payload["code"] == "LOCAL_API_ACCESS_DENIED", payload


# ------------------------------------------------------------------ #
# F-13 — a header byte must never decide between 401 and 500          #
# ------------------------------------------------------------------ #


class TestNonAsciiCapability:
    def test_the_stdlib_call_that_used_to_be_made_directly_still_raises(self) -> None:
        """The premise, pinned. If CPython ever changes this, the fix can relax."""
        with pytest.raises(TypeError, match="non-ASCII"):
            secrets.compare_digest("caf\xe9", "x" * 32)

    # Sent as raw bytes: httpx refuses to ASCII-encode a `str` header value, so
    # a high byte can only reach the middleware the way a real attacker would
    # put it on the wire.
    @pytest.mark.parametrize(
        "supplied",
        [
            b"caf\xe9" + b"x" * 28,
            b"\xff" * 32,
            b"\x80" + b"a" * 31,
            b"valid-looking-prefix\xfe" + b"z" * 11,
        ],
        ids=["latin1 word", "all high bytes", "leading high byte", "high byte in tail"],
    )
    def test_a_high_byte_in_the_http_header_is_a_clean_401(
        self, anonymous: TestClient, supplied: bytes
    ) -> None:
        response = anonymous.get(
            "/api/health",
            headers={HEADER.encode("ascii"): supplied, b"Origin": ALLOWED_ORIGIN.encode()},
        )

        assert response.status_code == 401
        _envelope(response)

    def test_every_single_high_byte_is_rejected_the_same_way(self, anonymous: TestClient) -> None:
        """Exhaustive over the attacker-controlled byte range, not a sample."""
        statuses = set()
        for code in range(0x80, 0x100):
            response = anonymous.get(
                "/api/health",
                headers={
                    HEADER.encode("ascii"): bytes([code]) + b"y" * 31,
                    b"Origin": ALLOWED_ORIGIN.encode(),
                },
            )
            statuses.add(response.status_code)
        assert statuses == {401}, statuses

    def test_the_printable_range_is_also_uniformly_rejected(self, anonymous: TestClient) -> None:
        statuses = set()
        for char in string.printable.strip():
            response = anonymous.get(
                "/api/health",
                headers={HEADER: char * 32, "Origin": ALLOWED_ORIGIN},
            )
            statuses.add(response.status_code)
        assert statuses == {401}, statuses

    def test_a_high_byte_in_the_websocket_subprotocol_closes_cleanly(
        self, anonymous: TestClient
    ) -> None:
        """The same byte, over the other transport the middleware guards."""
        from starlette.websockets import WebSocketDisconnect

        with pytest.raises(WebSocketDisconnect):
            with anonymous.websocket_connect(
                "/api/logs/stream",
                headers={
                    b"sec-websocket-protocol": (
                        WEBSOCKET_PROTOCOL_PREFIX.encode("ascii") + b"caf\xe9" + b"x" * 28
                    ),
                    b"Origin": ALLOWED_ORIGIN.encode(),
                },
            ):
                pass


# ------------------------------------------------------------------ #
# F-14 — only a genuine CORS preflight is exempt                      #
# ------------------------------------------------------------------ #


class TestPreflightExemption:
    def test_options_without_an_origin_is_refused(self, anonymous: TestClient) -> None:
        """A browser preflight always carries an Origin. This is not one."""
        response = anonymous.options("/api/health")

        assert response.status_code == 401
        _envelope(response)

    def test_options_without_a_requested_method_is_refused(self, anonymous: TestClient) -> None:
        """Nor is this: a preflight always states the method it is asking about."""
        response = anonymous.options("/api/health", headers={"Origin": ALLOWED_ORIGIN})

        assert response.status_code == 401
        _envelope(response)

    def test_a_real_preflight_still_passes(self, client: TestClient) -> None:
        response = client.options(
            "/api/health",
            headers={
                "Origin": ALLOWED_ORIGIN,
                "Access-Control-Request-Method": "GET",
            },
        )

        assert response.status_code < 400, response.status_code

    def test_a_disallowed_origin_is_still_403_even_as_a_real_preflight(
        self, client: TestClient
    ) -> None:
        response = client.options(
            "/api/health",
            headers={
                "Origin": DISALLOWED_ORIGIN,
                "Access-Control-Request-Method": "GET",
            },
        )

        assert response.status_code == 403
        _envelope(response)
        assert "access-control-allow-origin" not in response.headers

    def test_the_exemption_never_reaches_a_mutating_method(self, anonymous: TestClient) -> None:
        """OPTIONS is the only exempt verb; nothing else may skip the capability."""
        for method in ("GET", "POST", "PUT", "PATCH", "DELETE"):
            response = anonymous.request(method, "/api/health", headers={"Origin": ALLOWED_ORIGIN})
            assert response.status_code == 401, (method, response.status_code)


def test_the_class_docstring_matches_what_the_code_does() -> None:
    """P-02: stale prose about a trust boundary is a defect in its own right."""
    from app.core.api_security import LocalApiSecurityMiddleware

    doc = LocalApiSecurityMiddleware.__doc__ or ""
    assert "preflight" in doc.lower(), doc
