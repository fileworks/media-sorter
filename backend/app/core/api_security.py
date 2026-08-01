"""Authentication and exact-origin policy for the privileged loopback API."""

from __future__ import annotations

import secrets
from collections.abc import Awaitable, Callable
from typing import Any

from starlette.types import Receive, Scope, Send

CAPABILITY_HEADER = "x-mediasorter-capability"
WEBSOCKET_PROTOCOL_PREFIX = "mediasorter."
PACKAGED_ORIGINS = frozenset(
    {
        "tauri://localhost",
        "https://tauri.localhost",
        "http://tauri.localhost",
    }
)


def allowed_origins(development_origins: str | None) -> frozenset[str]:
    configured = {
        value.strip().rstrip("/")
        for value in (development_origins or "").split(",")
        if value.strip()
    }
    return PACKAGED_ORIGINS | configured


def _headers(scope: Scope) -> dict[str, str]:
    return {
        key.decode("latin-1").lower(): value.decode("latin-1")
        for key, value in scope.get("headers", ())
    }


def _websocket_capability(headers: dict[str, str]) -> str:
    for protocol in headers.get("sec-websocket-protocol", "").split(","):
        value = protocol.strip()
        if value.startswith(WEBSOCKET_PROTOCOL_PREFIX):
            return value.removeprefix(WEBSOCKET_PROTOCOL_PREFIX)
    return ""


class LocalApiSecurityMiddleware:
    """Reject unauthenticated HTTP/WebSocket traffic before route dispatch."""

    def __init__(
        self,
        app: Callable[[Scope, Receive, Send], Awaitable[None]],
        *,
        capability: str,
        origins: frozenset[str],
    ) -> None:
        if len(capability) < 32:
            raise ValueError("MEDIASORT_API_CAPABILITY must contain at least 32 characters")
        self.app = app
        self.capability = capability
        self.origins = origins

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        scope_type = scope["type"]
        if scope_type not in {"http", "websocket"}:
            await self.app(scope, receive, send)
            return

        headers = _headers(scope)
        origin = headers.get("origin")
        if origin is not None and origin.rstrip("/") not in self.origins:
            await self._reject(scope_type, send, status=403, reason="Origin not allowed")
            return

        # Browsers cannot include the secret header in a preflight. Exact-origin
        # CORS may proceed; the actual resource request remains authenticated.
        if scope_type == "http" and scope.get("method") == "OPTIONS":
            await self.app(scope, receive, send)
            return

        supplied = (
            headers.get(CAPABILITY_HEADER, "")
            if scope_type == "http"
            else _websocket_capability(headers)
        )
        if not secrets.compare_digest(supplied, self.capability):
            await self._reject(scope_type, send, status=401, reason="Authentication required")
            return
        await self.app(scope, receive, send)

    @staticmethod
    async def _reject(scope_type: str, send: Send, *, status: int, reason: str) -> None:
        if scope_type == "websocket":
            await send({"type": "websocket.close", "code": 1008, "reason": reason})
            return
        body = b'{"error":"Local API access denied","code":"LOCAL_API_ACCESS_DENIED"}'
        await send(
            {
                "type": "http.response.start",
                "status": status,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(body)).encode("ascii")),
                    (b"cache-control", b"no-store"),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})


def websocket_protocol(headers: Any) -> str | None:
    """Return the authenticated subprotocol so Starlette completes the handshake."""
    return next(
        (
            value.strip()
            for value in headers.get("sec-websocket-protocol", "").split(",")
            if value.strip().startswith(WEBSOCKET_PROTOCOL_PREFIX)
        ),
        None,
    )
