"""The optimization API must never let a preview look like an execution."""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient


def _png(path: Path, *, size: tuple[int, int] = (64, 48)) -> Path:
    from PIL import Image

    image = Image.new("RGB", size, (10, 20, 30))
    for x in range(0, size[0], 2):
        for y in range(0, size[1], 3):
            image.putpixel((x, y), ((x * 5) % 256, (y * 11) % 256, 128))
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, compress_level=0)
    return path


class TestContracts:
    def test_every_contract_is_listed_with_its_status_and_tooling(self, client: TestClient) -> None:
        response = client.get("/api/optimization/contracts")

        assert response.status_code == 200
        contracts = {item["contract_id"]: item for item in response.json()}
        assert "image-png-lossless-v1" in contracts
        png = contracts["image-png-lossless-v1"]
        assert png["mode"] == "lossless"
        assert png["metrics"] and png["decoded_content"]
        assert png["compatibility_warnings"]

    def test_nothing_is_enabled_by_default(self, client: TestClient) -> None:
        response = client.get("/api/optimization/contracts")

        assert all(not item["enabled"] for item in response.json())

    def test_a_lossy_contract_is_named_as_lossy(self, client: TestClient) -> None:
        contracts = {
            item["contract_id"]: item for item in client.get("/api/optimization/contracts").json()
        }

        hevc = contracts["video-h265-visually-lossless-v1"]

        assert hevc["mode"] == "visually_lossless"
        assert "lossy" in hevc["decoded_content"].lower()


class TestPreview:
    def test_preview_projects_without_touching_the_originals(
        self, client: TestClient, tmp_path: Path
    ) -> None:
        sources = [_png(tmp_path / f"{index}.png") for index in range(3)]
        before = [path.read_bytes() for path in sources]

        response = client.post(
            "/api/optimization/preview",
            json={
                "contract_id": "image-png-lossless-v1",
                "paths": [str(path) for path in sources],
                "retain_samples": False,
            },
        )

        assert response.status_code == 200
        body = response.json()
        assert body["item_count"] == 3
        assert body["estimate_only"] is True  # no candidate was retained
        assert [path.read_bytes() for path in sources] == before

    def test_every_item_carries_its_confidence_and_reason(
        self, client: TestClient, tmp_path: Path
    ) -> None:
        source = _png(tmp_path / "photo.png")

        body = client.post(
            "/api/optimization/preview",
            json={
                "contract_id": "image-png-lossless-v1",
                "paths": [str(source)],
                "retain_samples": False,
            },
        ).json()

        item = body["items"][0]
        assert item["confidence"] in {"measured", "sampled", "estimated", "unknown"}
        assert item["reason"]
        assert item["validation_method"]
        assert item["quarantine_space_bytes"] == source.stat().st_size

    def test_unknown_contract_is_a_client_error(self, client: TestClient, tmp_path: Path) -> None:
        source = _png(tmp_path / "photo.png")

        response = client.post(
            "/api/optimization/preview",
            json={"contract_id": "nope-v1", "paths": [str(source)]},
        )

        assert response.status_code == 400

    def test_unreadable_paths_are_refused_rather_than_projected(
        self, client: TestClient, tmp_path: Path
    ) -> None:
        response = client.post(
            "/api/optimization/preview",
            json={
                "contract_id": "image-png-lossless-v1",
                "paths": [str(tmp_path / "missing.png")],
            },
        )

        assert response.status_code == 400


class TestQuarantineRoutes:
    def test_empty_quarantine_reports_zeroes_not_an_error(self, client: TestClient) -> None:
        response = client.get("/api/quarantine/summary")

        assert response.status_code == 200
        assert response.json()["retained_count"] == 0

    def test_listing_an_empty_quarantine_returns_an_empty_list(self, client: TestClient) -> None:
        assert client.get("/api/quarantine").json() == []

    def test_restoring_an_unknown_record_is_a_not_found(self, client: TestClient) -> None:
        response = client.post(
            "/api/quarantine/restore/preview",
            json={"record_id": "qtn_missing"},
        )

        assert response.status_code == 404
