"""Shared long-operation API contract."""

from __future__ import annotations

import asyncio
import time
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.core.bootstrap import AppFactory
from app.core.config import Config

_TASK_ROUTES = {
    "analysis": ("/api/analysis/start", "/api/analysis"),
    "scan": ("/api/scan/start", "/api/scan"),
    "preview": ("/api/preview/start", "/api/preview"),
    "sort": ("/api/sorting/start", "/api/sorting"),
}


def _wait_terminal(client: TestClient, path: str) -> dict:
    deadline = time.time() + 5
    payload = client.get(path).json()
    while payload["status"] in {"pending", "running"} and time.time() < deadline:
        time.sleep(0.01)
        payload = client.get(path).json()
    return payload


def _start_operation(client: TestClient, kind: str, key: str) -> dict:
    start_path, status_base = _TASK_ROUTES[kind]
    body = {"idempotency_key": key}
    if kind == "sort":
        body["dry_run"] = True
    start = client.post(start_path, json=body)
    assert start.status_code == 200
    return _wait_terminal(client, f"{status_base}/{start.json()['task_id']}")


def test_all_operation_kinds_use_typed_start_and_status(tmp_path: Path) -> None:
    source = tmp_path / "source"
    target = tmp_path / "target"
    source.mkdir()
    target.mkdir()
    app = AppFactory.create(Config(source_directory=str(source), target_directory=str(target)))
    with TestClient(app) as client:
        for kind, (start_path, status_base) in _TASK_ROUTES.items():
            start = client.post(
                start_path,
                json={"idempotency_key": f"{kind}-key", "dry_run": True}
                if kind == "sort"
                else {"idempotency_key": f"{kind}-key"},
            )
            assert start.status_code == 200
            identity = start.json()
            assert identity["operation_kind"] == kind
            status = _wait_terminal(client, f"{status_base}/{identity['task_id']}")
            assert status["operation_kind"] == kind
            assert status["status"] == "completed"
            assert isinstance(status["events"], list)
            assert status["last_event_sequence"] >= 1
            assert status["failure"] is None


def test_all_operations_share_unavailable_source_failures(tmp_path: Path) -> None:
    target = tmp_path / "target"
    target.mkdir()
    source_file = tmp_path / "not-a-folder.jpg"
    source_file.write_bytes(b"x")
    sources = {
        "unset": "",
        "missing": str(tmp_path / "unmounted"),
        "not_directory": str(source_file),
    }

    for expected_reason, source in sources.items():
        app = AppFactory.create(Config(source_directory=source, target_directory=str(target)))
        with TestClient(app) as client:
            for kind in _TASK_ROUTES:
                terminal = _start_operation(
                    client,
                    kind,
                    f"{expected_reason}-{kind}",
                )
                assert terminal["status"] == "failed"
                assert terminal["failure"]["code"] == "SOURCE_UNAVAILABLE"
                assert terminal["failure"]["details"]["reason"] == expected_reason


def test_all_operations_share_root_inaccessible_failure(tmp_path: Path) -> None:
    source = tmp_path / "source"
    target = tmp_path / "target"
    source.mkdir()
    target.mkdir()
    app = AppFactory.create(Config(source_directory=str(source), target_directory=str(target)))

    with (
        TestClient(app) as client,
        patch(
            "app.utils.path_utils.os.scandir",
            side_effect=PermissionError("source denied"),
        ),
    ):
        for kind in _TASK_ROUTES:
            terminal = _start_operation(client, kind, f"inaccessible-{kind}")
            assert terminal["status"] == "failed"
            assert terminal["failure"]["code"] == "SOURCE_UNAVAILABLE"
            assert terminal["failure"]["details"]["reason"] == "root_inaccessible"


def test_all_operations_accept_fully_excluded_source_as_valid_empty(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source"
    target = tmp_path / "target"
    source.mkdir()
    target.mkdir()
    (source / "excluded.jpg").write_bytes(b"media")
    app = AppFactory.create(
        Config(
            source_directory=str(source),
            target_directory=str(target),
            exclude_patterns=["*.jpg"],
        )
    )
    result_count_fields = {
        "analysis": "total_files",
        "scan": "total",
        "preview": "items",
        "sort": "total",
    }

    with TestClient(app) as client:
        for kind, field in result_count_fields.items():
            terminal = _start_operation(client, kind, f"excluded-{kind}")
            assert terminal["status"] == "completed"
            result = terminal["result"]
            count = len(result[field]) if field == "items" else result[field]
            assert count == 0


def test_same_key_replay_conflict_details_and_idempotent_cancel(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source"
    target = tmp_path / "target"
    source.mkdir()
    target.mkdir()
    app = AppFactory.create(Config(source_directory=str(source), target_directory=str(target)))

    async def slow_analysis(config, *, task):
        while not task.cancel_token.is_set():
            await asyncio.sleep(0.01)
        return {"cancelled": True}

    with TestClient(app) as client:
        service = app.state.container.analysis_service
        with patch.object(service, "analyse", side_effect=slow_analysis):
            first = client.post(
                "/api/analysis/start",
                json={"idempotency_key": "lost-response"},
            ).json()
            replay = client.post(
                "/api/analysis/start",
                json={"idempotency_key": "lost-response"},
            ).json()
            assert replay["task_id"] == first["task_id"]
            assert replay["replayed"] is True

            conflict = client.post(
                "/api/preview/start",
                json={"idempotency_key": "other"},
            )
            assert conflict.status_code == 409
            assert conflict.json()["details"] == {
                "active_task_id": first["task_id"],
                "active_operation_kind": "analysis",
            }

            cancel_path = f"/api/analysis/{first['task_id']}/cancel"
            assert client.post(cancel_path).status_code == 200
            assert client.post(cancel_path).status_code == 200
            terminal = _wait_terminal(client, f"/api/analysis/{first['task_id']}")
            assert terminal["status"] == "cancelled"


def test_validation_failure_is_terminal_and_unknown_id_is_404(tmp_path: Path) -> None:
    app = AppFactory.create(
        Config(source_directory=str(tmp_path / "missing"), target_directory=str(tmp_path))
    )
    with TestClient(app) as client:
        task_id = client.post(
            "/api/scan/start",
            json={"idempotency_key": "missing"},
        ).json()["task_id"]
        terminal = _wait_terminal(client, f"/api/scan/{task_id}")
        assert terminal["status"] == "failed"
        assert terminal["failure"]["code"] == "SOURCE_UNAVAILABLE"
        assert "mounted" in terminal["failure"]["message"]

        assert client.get("/api/scan/unknown").status_code == 404
        assert client.post("/api/scan/unknown/cancel").status_code == 404


def test_after_sequence_and_transport_retry_events_are_correlated(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source"
    target = tmp_path / "target"
    source.mkdir()
    target.mkdir()
    app = AppFactory.create(Config(source_directory=str(source), target_directory=str(target)))
    with TestClient(app) as client:
        task_id = client.post(
            "/api/scan/start",
            json={"idempotency_key": "events"},
        ).json()["task_id"]
        terminal = _wait_terminal(client, f"/api/scan/{task_id}")
        sequence = terminal["last_event_sequence"]
        retried = client.get(
            f"/api/scan/{task_id}",
            params={"after_sequence": sequence},
            headers={
                "X-MediaSorter-Retry-Attempt": "1",
                "X-MediaSorter-Transport-Event": "timeout",
            },
        ).json()
        names = [event["name"] for event in retried["events"]]
        assert names == [
            "operation.transport_timeout",
            "operation.transport_retry",
        ]
