"""Integration test for the health endpoint."""

import pytest
from fastapi.testclient import TestClient

from app.core.bootstrap import AppFactory
from app.core.config import Config


@pytest.fixture(scope="module")
def client() -> TestClient:
    app = AppFactory.create(config=Config.defaults())
    return TestClient(app)


def test_health_returns_ok(client: TestClient) -> None:
    response = client.get("/api/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert "version" in body
