"""The probe authenticates, fails closed and never prints the capability."""

from __future__ import annotations

import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest
import yaml

from app.core.container_health import is_healthy

_CAPABILITY = "container-health-test-capability-0123456789"


@pytest.fixture
def health_server() -> Iterator[str]:
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            if self.headers.get("X-MediaSorter-Capability") != _CAPABILITY:
                status = 401
            else:
                status = 503 if self.path == "/unhealthy" else 200
            self.send_response(status)
            self.end_headers()

        def log_message(self, format: str, *args: object) -> None:
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=5)


def test_authenticated_probe_bypasses_environment_proxy(
    health_server: str, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("MEDIASORT_API_CAPABILITY", _CAPABILITY)
    monkeypatch.setenv("http_proxy", "http://127.0.0.1:1")
    monkeypatch.setenv("no_proxy", "")
    assert is_healthy(health_server + "/api/health")
    assert capsys.readouterr() == ("", "")


@pytest.mark.parametrize("capability", ["", "short", "wrong-capability-with-sufficient-length"])
def test_missing_or_wrong_capability_fails_closed(
    health_server: str, capability: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("MEDIASORT_API_CAPABILITY", capability)
    assert not is_healthy(health_server + "/api/health")


def test_unhealthy_response_fails(health_server: str, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MEDIASORT_API_CAPABILITY", _CAPABILITY)
    assert not is_healthy(health_server + "/unhealthy")


def test_connection_failure_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MEDIASORT_API_CAPABILITY", _CAPABILITY)
    with HTTPServer(("127.0.0.1", 0), BaseHTTPRequestHandler) as server:
        url = f"http://127.0.0.1:{server.server_port}"
    assert not is_healthy(url)


def test_compose_requires_capability_and_binds_loopback() -> None:
    root = Path(__file__).resolve().parents[2]
    backend = yaml.safe_load((root / "docker-compose.yml").read_text(encoding="utf-8"))["services"][
        "backend"
    ]
    assert backend["ports"] == ["127.0.0.1:8000:8000"]
    assert backend["environment"]["MEDIASORT_API_CAPABILITY"].startswith(
        "${MEDIASORT_API_CAPABILITY:?"
    )
    assert backend["healthcheck"]["test"] == ["CMD", "python", "-m", "app.core.container_health"]


def test_dockerfile_runs_the_authenticated_probe() -> None:
    backend = Path(__file__).resolve().parents[1]
    dockerfile = (backend / "Dockerfile").read_text(encoding="utf-8")
    assert "COPY app/ ./app/" in dockerfile
    assert "CMD python -m app.core.container_health" in dockerfile
