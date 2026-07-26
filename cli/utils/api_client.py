"""Thin HTTP client for the MediaSorter FastAPI backend."""

from __future__ import annotations

import time
import uuid
from typing import Any, cast

import httpx

_RETRY_DELAYS = (0.25, 0.75)
_TRANSIENT_STATUSES = frozenset({408, 429})


class APIClientError(RuntimeError):
    """A structured backend failure suitable for terminal output."""

    def __init__(
        self,
        message: str,
        *,
        code: str = "HTTP_ERROR",
        details: dict[str, Any] | None = None,
    ) -> None:
        self.code = code
        self.details = details or {}
        suffix = ""
        active_id = self.details.get("active_task_id")
        active_kind = self.details.get("active_operation_kind")
        if active_id and active_kind:
            suffix = f" (active {active_kind} task: {active_id})"
        super().__init__(f"{message}{suffix}")


class APIClient:
    """Synchronous wrapper around the MediaSorter REST API."""

    def __init__(self, base_url: str = "http://localhost:8000") -> None:
        self.base_url = base_url.rstrip("/")
        timeout = httpx.Timeout(5.0, connect=2.0)
        self._http = httpx.Client(base_url=self.base_url, timeout=timeout)

    def _request(
        self,
        method: str,
        path: str,
        *,
        json: dict[str, Any] | None = None,
        params: dict[str, Any] | None = None,
        retry: bool = False,
    ) -> httpx.Response:
        last_error: Exception | None = None
        prior_timed_out = False
        attempts = len(_RETRY_DELAYS) + 1 if retry else 1
        for attempt in range(attempts):
            headers = (
                {
                    "X-MediaSorter-Retry-Attempt": str(attempt),
                    "X-MediaSorter-Transport-Event": (
                        "timeout" if prior_timed_out else "retry"
                    ),
                }
                if attempt
                else None
            )
            try:
                response = self._http.request(
                    method,
                    path,
                    json=json,
                    params=params,
                    headers=headers,
                )
            except (httpx.TimeoutException, httpx.NetworkError) as exc:
                last_error = exc
                prior_timed_out = isinstance(exc, httpx.TimeoutException)
                if attempt + 1 >= attempts:
                    raise
            else:
                transient = (
                    response.status_code in _TRANSIENT_STATUSES
                    or response.status_code >= 500
                )
                if not transient or attempt + 1 >= attempts:
                    if response.is_error:
                        self._raise_api_error(response)
                    return response
                prior_timed_out = False
            time.sleep(_RETRY_DELAYS[attempt])
        assert last_error is not None
        raise last_error

    @staticmethod
    def _raise_api_error(response: httpx.Response) -> None:
        try:
            payload = response.json()
        except ValueError:
            payload = {}
        message = (
            payload.get("error") or f"Backend returned HTTP {response.status_code}"
        )
        raise APIClientError(
            str(message),
            code=str(payload.get("code") or "HTTP_ERROR"),
            details=payload.get("details")
            if isinstance(payload.get("details"), dict)
            else None,
        )

    @staticmethod
    def _json(response: httpx.Response) -> dict[str, Any]:
        payload = response.json()
        if not isinstance(payload, dict):
            raise APIClientError("Backend returned an invalid JSON response")
        return cast(dict[str, Any], payload)

    # ------------------------------------------------------------------ #
    # Health and config                                                     #
    # ------------------------------------------------------------------ #

    def get_health(self) -> dict[str, Any]:
        return self._json(self._request("GET", "/api/health", retry=True))

    def get_config(self) -> dict[str, Any]:
        return self._json(self._request("GET", "/api/config", retry=True))

    def update_config(self, updates: dict[str, Any]) -> dict[str, Any]:
        return self._json(self._request("POST", "/api/config", json=updates))

    def validate_config(self) -> dict[str, Any]:
        return self._json(self._request("POST", "/api/config/validate"))

    # ------------------------------------------------------------------ #
    # Shared long-operation transport                                      #
    # ------------------------------------------------------------------ #

    def _start(
        self,
        kind: str,
        *,
        idempotency_key: str | None = None,
        extra: dict[str, Any] | None = None,
    ) -> str:
        body = dict(extra or {})
        body["idempotency_key"] = idempotency_key or str(uuid.uuid4())
        route = "/api/sorting/start" if kind == "sort" else f"/api/{kind}/start"
        return str(
            self._json(self._request("POST", route, json=body, retry=True))["task_id"]
        )

    def _progress(
        self, kind: str, task_id: str, *, after_sequence: int = 0
    ) -> dict[str, Any]:
        route = (
            f"/api/sorting/{task_id}" if kind == "sort" else f"/api/{kind}/{task_id}"
        )
        return self._json(
            self._request(
                "GET",
                route,
                params={"after_sequence": after_sequence},
                retry=True,
            )
        )

    def _cancel(self, kind: str, task_id: str) -> dict[str, Any]:
        route = (
            f"/api/sorting/{task_id}/cancel"
            if kind == "sort"
            else f"/api/{kind}/{task_id}/cancel"
        )
        return self._json(self._request("POST", route, retry=True))

    def start_scan(self, idempotency_key: str | None = None) -> str:
        return self._start("scan", idempotency_key=idempotency_key)

    def get_scan_progress(
        self, task_id: str, *, after_sequence: int = 0
    ) -> dict[str, Any]:
        return self._progress("scan", task_id, after_sequence=after_sequence)

    def cancel_scan(self, task_id: str) -> dict[str, Any]:
        return self._cancel("scan", task_id)

    def start_analysis(self, idempotency_key: str | None = None) -> str:
        return self._start("analysis", idempotency_key=idempotency_key)

    def get_analysis_progress(
        self, task_id: str, *, after_sequence: int = 0
    ) -> dict[str, Any]:
        return self._progress("analysis", task_id, after_sequence=after_sequence)

    def cancel_analysis(self, task_id: str) -> dict[str, Any]:
        return self._cancel("analysis", task_id)

    def start_preview(self, idempotency_key: str | None = None) -> str:
        return self._start("preview", idempotency_key=idempotency_key)

    def get_preview_progress(
        self, task_id: str, *, after_sequence: int = 0
    ) -> dict[str, Any]:
        return self._progress("preview", task_id, after_sequence=after_sequence)

    def cancel_preview(self, task_id: str) -> dict[str, Any]:
        return self._cancel("preview", task_id)

    def start_sorting(
        self, dry_run: bool = False, idempotency_key: str | None = None
    ) -> str:
        return self._start(
            "sort",
            idempotency_key=idempotency_key,
            extra={"dry_run": dry_run},
        )

    def get_sorting_progress(
        self, task_id: str, *, after_sequence: int = 0
    ) -> dict[str, Any]:
        return self._progress("sort", task_id, after_sequence=after_sequence)

    def cancel_sorting(self, task_id: str) -> dict[str, Any]:
        return self._cancel("sort", task_id)

    def get_sorting_report(self, task_id: str) -> dict[str, Any]:
        return self._json(
            self._request("GET", f"/api/sorting/{task_id}/report", retry=True)
        )

    # ------------------------------------------------------------------ #
    # Reports                                                               #
    # ------------------------------------------------------------------ #

    def get_operation_report(self, operation_id: str) -> dict[str, Any]:
        return self._json(
            self._request("GET", f"/api/reports/{operation_id}", retry=True)
        )

    def export_report(self, operation_id: str, fmt: str = "json") -> bytes:
        return self._request(
            "POST",
            f"/api/reports/{operation_id}/export",
            json={"format": fmt},
        ).content

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> APIClient:
        return self

    def __exit__(self, *args: Any) -> None:
        self.close()
