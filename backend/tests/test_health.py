"""Integration test for the health endpoint."""

from typing import cast

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.background_tasks.task_manager import Task
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


def test_diagnostics_exposes_only_active_task_identity(client: TestClient) -> None:
    app = cast(FastAPI, client.app)
    manager = app.state.container.task_manager
    task = Task(id="active-sort", operation_kind="sort", status="running")
    manager._tasks[task.id] = task  # noqa: SLF001 - fixture owns this in-memory manager
    try:
        response = client.get("/api/diagnostics")
    finally:
        manager._tasks.pop(task.id, None)  # noqa: SLF001

    assert response.status_code == 200
    assert response.json()["active_task"] == {
        "task_id": "active-sort",
        "operation_kind": "sort",
        "status": "running",
        "started_at": None,
    }
