from pathlib import Path

from fastapi.testclient import TestClient
from PIL import Image


def test_audit_is_headless_read_only_and_exportable(
    client: TestClient,
    tmp_path: Path,
) -> None:
    root = tmp_path / "organized"
    root.mkdir()
    media = root / "photo.jpg"
    Image.new("RGB", (12, 12)).save(media)
    before = media.read_bytes()

    response = client.post("/api/audit", json={"root": str(root), "scope": {}})

    assert response.status_code == 200
    payload = response.json()
    assert payload["coverage"] == "full"
    assert payload["baseline_established"] == 1
    assert media.read_bytes() == before

    report = client.get(f"/api/audit/reports/{payload['audit_id']}")
    assert report.status_code == 200
    exported = client.post(
        f"/api/audit/reports/{payload['audit_id']}/export",
        json={"format": "csv"},
    )
    assert exported.status_code == 200
    assert exported.headers["content-type"].startswith("text/csv")


def test_audit_start_returns_ordinary_task(
    client: TestClient,
    tmp_path: Path,
) -> None:
    root = tmp_path / "organized"
    root.mkdir()
    response = client.post(
        "/api/audit/start",
        json={"root": str(root), "scope": {}, "idempotency_key": "audit-api-test"},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["operation_kind"] == "audit"
    assert payload["task_id"]
