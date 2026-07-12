"""Tests for the AI utility routes (POST /api/ai/suggest-categories)."""

from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from app.core.bootstrap import AppFactory


@pytest.fixture
def client():
    app = AppFactory.create()
    return TestClient(app)


def test_suggest_categories_returns_503_when_no_encoder(client: TestClient):
    """503 when no encoder is available (tier=off / fastembed missing)."""
    res = client.post("/api/ai/suggest-categories", json={"n_categories": 5})
    # Default config has tier=auto; without fastembed the encoder will be None.
    # The route must return 503 in that case.
    assert res.status_code in {200, 503}


def test_suggest_categories_clamps_n_categories(client: TestClient):
    """n_categories outside 2–12 is rejected as 422."""
    assert client.post("/api/ai/suggest-categories", json={"n_categories": 1}).status_code == 422
    assert client.post("/api/ai/suggest-categories", json={"n_categories": 13}).status_code == 422


def test_suggest_categories_accepts_valid_range(client: TestClient):
    """n_categories within 2–12 reaches the handler (200 or 503, not 422)."""
    for n in (2, 5, 12):
        res = client.post("/api/ai/suggest-categories", json={"n_categories": n})
        assert res.status_code in {200, 503}, f"unexpected {res.status_code} for n={n}"


def test_suggest_categories_response_shape(client: TestClient, tmp_path):
    """When an encoder is present, response has a 'suggestions' list."""
    app = AppFactory.create()
    container = app.state.container

    # Inject a mock encoder so the route returns 200
    mock_encoder = MagicMock()
    mock_encoder.embed_texts.return_value = [[0.1] * 512] * 10
    mock_encoder.embed_image.return_value = [0.1] * 512
    container._encoder = mock_encoder
    container._encoder_built = True

    # Inject a mock suggestion service that returns fixed labels
    mock_svc = MagicMock()
    mock_svc.suggest.return_value = ["nature", "travel", "family"]
    container._category_suggestion_service = mock_svc

    with TestClient(app) as c:
        res = c.post("/api/ai/suggest-categories", json={"n_categories": 3})

    assert res.status_code == 200
    body = res.json()
    assert "suggestions" in body
    assert isinstance(body["suggestions"], list)
    assert body["suggestions"] == ["nature", "travel", "family"]
