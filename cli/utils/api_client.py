"""Thin HTTP client for the MediaSorter FastAPI backend."""

from __future__ import annotations

from typing import Any, Dict

import httpx


class APIClient:
    """Synchronous wrapper around the MediaSorter REST API."""

    def __init__(self, base_url: str = "http://localhost:8000") -> None:
        self.base_url = base_url.rstrip("/")
        self._http = httpx.Client(base_url=self.base_url, timeout=30.0)

    # ------------------------------------------------------------------ #
    # Health                                                                #
    # ------------------------------------------------------------------ #

    def get_health(self) -> Dict[str, Any]:
        resp = self._http.get("/api/health")
        resp.raise_for_status()
        return resp.json()

    # ------------------------------------------------------------------ #
    # Config                                                                #
    # ------------------------------------------------------------------ #

    def get_config(self) -> Dict[str, Any]:
        resp = self._http.get("/api/config")
        resp.raise_for_status()
        return resp.json()

    def update_config(self, updates: Dict[str, Any]) -> Dict[str, Any]:
        resp = self._http.post("/api/config", json=updates)
        resp.raise_for_status()
        return resp.json()

    def validate_config(self) -> Dict[str, Any]:
        resp = self._http.post("/api/config/validate")
        resp.raise_for_status()
        return resp.json()

    # ------------------------------------------------------------------ #
    # Scan                                                                  #
    # ------------------------------------------------------------------ #

    def scan_source(self) -> Dict[str, Any]:
        resp = self._http.post("/api/scan")
        resp.raise_for_status()
        return resp.json()

    # ------------------------------------------------------------------ #
    # Preview                                                               #
    # ------------------------------------------------------------------ #

    def preview(self) -> Dict[str, Any]:
        resp = self._http.post("/api/preview")
        resp.raise_for_status()
        return resp.json()

    def start_preview(self) -> str:
        """Start a preview as a background task and return its task id."""
        resp = self._http.post("/api/preview/start")
        resp.raise_for_status()
        return resp.json()["task_id"]

    def get_preview_progress(self, task_id: str) -> Dict[str, Any]:
        resp = self._http.get(f"/api/preview/{task_id}")
        resp.raise_for_status()
        return resp.json()

    # ------------------------------------------------------------------ #
    # Sorting                                                               #
    # ------------------------------------------------------------------ #

    def start_sorting(self, dry_run: bool = False) -> str:
        resp = self._http.post("/api/sorting/start", json={"dry_run": dry_run})
        resp.raise_for_status()
        return resp.json()["task_id"]

    def get_sorting_progress(self, task_id: str) -> Dict[str, Any]:
        resp = self._http.get(f"/api/sorting/{task_id}")
        resp.raise_for_status()
        return resp.json()

    def cancel_sorting(self, task_id: str) -> Dict[str, Any]:
        resp = self._http.post(f"/api/sorting/{task_id}/cancel")
        resp.raise_for_status()
        return resp.json()

    def get_sorting_report(self, task_id: str) -> Dict[str, Any]:
        resp = self._http.get(f"/api/sorting/{task_id}/report")
        resp.raise_for_status()
        return resp.json()

    # ------------------------------------------------------------------ #
    # Reports                                                               #
    # ------------------------------------------------------------------ #

    def get_operation_report(self, operation_id: str) -> Dict[str, Any]:
        resp = self._http.get(f"/api/reports/{operation_id}")
        resp.raise_for_status()
        return resp.json()

    def export_report(self, operation_id: str, fmt: str = "json") -> bytes:
        resp = self._http.post(
            f"/api/reports/{operation_id}/export",
            json={"format": fmt},
        )
        resp.raise_for_status()
        return resp.content

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> "APIClient":
        return self

    def __exit__(self, *args: Any) -> None:
        self.close()
