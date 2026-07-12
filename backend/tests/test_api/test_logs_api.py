"""Integration tests for the /api/logs WebSocket route."""

from __future__ import annotations

import time

from fastapi.testclient import TestClient

from app.core.bootstrap import AppFactory
from app.core.config import Config
from app.core.log_queue import subscriber_count


def test_logs_ws_accepts_connection() -> None:
    app = AppFactory.create(config=Config.defaults())
    with TestClient(app) as client:
        with client.websocket_connect("/api/logs"):
            # Reaching here means the server accepted the upgrade.
            pass


def test_logs_ws_unsubscribes_on_disconnect() -> None:
    """The handler must exit (and unsubscribe) promptly when the client closes,
    rather than lingering as an idle task awaiting the log queue."""
    app = AppFactory.create(config=Config.defaults())
    with TestClient(app) as client:
        with client.websocket_connect("/api/logs"):
            # A subscriber is registered while connected.
            deadline = time.time() + 2
            while subscriber_count() == 0 and time.time() < deadline:
                time.sleep(0.02)
            assert subscriber_count() >= 1

        # After the client disconnects the handler must tear down and unsubscribe.
        deadline = time.time() + 5
        while subscriber_count() != 0 and time.time() < deadline:
            time.sleep(0.02)
        assert subscriber_count() == 0
