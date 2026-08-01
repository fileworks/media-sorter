from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.core.bootstrap import AppFactory
from app.core.config import Config


def test_unrelated_local_origin_cannot_read_api() -> None:
    app = AppFactory.create(config=Config.defaults())
    with TestClient(app) as client:
        response = client.get("/api/health", headers={"Origin": "http://localhost:49152"})

    assert response.status_code == 403
    assert "access-control-allow-origin" not in response.headers


def test_missing_capability_is_rejected_without_route_details() -> None:
    app = AppFactory.create(config=Config.defaults())
    with TestClient(app) as client:
        client.headers.pop("x-mediasorter-capability")
        response = client.get("/api/health")

    assert response.status_code == 401
    assert response.json() == {
        "error": "Local API access denied",
        "code": "LOCAL_API_ACCESS_DENIED",
    }


@pytest.mark.parametrize(
    "path",
    [
        "/api/health",
        "/api/config",
        "/api/review/groups",
        "/api/reports",
        "/api/media/image?path=/private/example.jpg",
    ],
)
def test_every_route_family_is_fail_closed_without_capability(path: str) -> None:
    app = AppFactory.create(config=Config.defaults())
    with TestClient(app) as client:
        client.headers.pop("x-mediasorter-capability")
        response = client.get(path)

    assert response.status_code == 401
    assert response.json()["code"] == "LOCAL_API_ACCESS_DENIED"


def test_exact_development_origin_is_allowed_with_capability() -> None:
    app = AppFactory.create(config=Config.defaults())
    with TestClient(app) as client:
        response = client.get("/api/health", headers={"Origin": "http://localhost:1420"})

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://localhost:1420"


def test_preflight_requires_an_exact_origin() -> None:
    app = AppFactory.create(config=Config.defaults())
    with TestClient(app) as client:
        allowed = client.options(
            "/api/health",
            headers={
                "Origin": "http://localhost:1420",
                "Access-Control-Request-Method": "GET",
                "Access-Control-Request-Headers": "x-mediasorter-capability",
            },
        )
        denied = client.options(
            "/api/health",
            headers={
                "Origin": "http://localhost:9999",
                "Access-Control-Request-Method": "GET",
            },
        )

    assert allowed.status_code == 200
    assert denied.status_code == 403


def test_capability_rotates_between_app_launches(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("MEDIASORT_API_CAPABILITY", raising=False)

    first = AppFactory.create(config=Config.defaults()).state.api_capability
    second = AppFactory.create(config=Config.defaults()).state.api_capability

    assert first != second
    assert len(first) >= 32
    assert len(second) >= 32


def test_websocket_rejects_missing_capability() -> None:
    app = AppFactory.create(config=Config.defaults())
    with TestClient(app) as client:
        client.headers.pop("x-mediasorter-capability")
        with pytest.raises(WebSocketDisconnect) as captured:
            with client.websocket_connect("/api/logs"):
                pass
    assert captured.value.code == 1008
