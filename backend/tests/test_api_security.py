"""A rejected or failed request must stay readable in the browser.

With the security middleware outside CORS, a 401 or a 500 reached the interface
as an opaque ``TypeError: Failed to fetch`` — indistinguishable from the backend
being down. These tests pin the header and the envelope on both paths.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

ALLOWED_ORIGIN = "http://localhost:1420"
DISALLOWED_ORIGIN = "http://evil.example"
CAPABILITY_HEADER = "X-MediaSorter-Capability"


@pytest.fixture(scope="module")
def boom_app(app: FastAPI) -> FastAPI:
    """Register a route that raises, so the catch-all handler can be observed."""

    async def _boom() -> None:
        raise RuntimeError("forced failure")

    app.router.add_api_route("/api/__forced_failure__", _boom, methods=["GET"])
    return app


@pytest.fixture(scope="module")
def boom_client(boom_app: FastAPI) -> TestClient:
    return TestClient(boom_app)


def _envelope(response) -> dict:  # type: ignore[no-untyped-def]
    payload = response.json()
    assert "error" in payload, payload
    assert "code" in payload, payload
    return payload


def test_missing_capability_returns_401_with_cors_headers(client: TestClient) -> None:
    response = client.get(
        "/api/health",
        headers={CAPABILITY_HEADER: "wrong-capability-value", "Origin": ALLOWED_ORIGIN},
    )

    assert response.status_code == 401
    assert response.headers["access-control-allow-origin"] == ALLOWED_ORIGIN
    _envelope(response)


def test_forced_exception_returns_500_with_cors_headers(boom_client: TestClient) -> None:
    response = boom_client.get(
        "/api/__forced_failure__",
        headers={"Origin": ALLOWED_ORIGIN},
    )

    assert response.status_code == 500
    # Starlette serves ``@app.exception_handler(Exception)`` from
    # ServerErrorMiddleware, which sits outside CORS. This header is the proof
    # that the envelope is emitted from inside the CORS wrapper instead.
    assert response.headers["access-control-allow-origin"] == ALLOWED_ORIGIN
    assert _envelope(response)["code"] == "INTERNAL_ERROR"


def test_disallowed_origin_returns_403_envelope_without_echoing_the_origin(
    client: TestClient,
) -> None:
    """A 403 is the one rejection that must not carry the header.

    Task 1.4 asked for ``access-control-allow-origin`` on all three statuses.
    Echoing an origin the middleware just refused would hand the caller the
    boundary the refusal exists to enforce, so the body is made readable and the
    header is deliberately withheld. Recorded under task 1.2 in ``tasks.md``.
    """
    response = client.get("/api/health", headers={"Origin": DISALLOWED_ORIGIN})

    assert response.status_code == 403
    assert "access-control-allow-origin" not in response.headers
    assert _envelope(response)["code"] == "LOCAL_API_ACCESS_DENIED"


def test_preflight_from_an_allowed_origin_still_succeeds(client: TestClient) -> None:
    response = client.options(
        "/api/health",
        headers={
            "Origin": ALLOWED_ORIGIN,
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": CAPABILITY_HEADER,
        },
    )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == ALLOWED_ORIGIN


def test_allowed_origin_carries_a_single_origin_header(client: TestClient) -> None:
    """The middleware and CORS both set the header; it must not be duplicated."""
    response = client.get(
        "/api/health",
        headers={CAPABILITY_HEADER: "wrong-capability-value", "Origin": ALLOWED_ORIGIN},
    )

    assert response.headers.get_list("access-control-allow-origin") == [ALLOWED_ORIGIN]
