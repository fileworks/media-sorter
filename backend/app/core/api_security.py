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
    """Reject unauthenticated HTTP/WebSocket traffic before route dispatch.

    One exemption exists, and it is narrow: a **genuine CORS preflight** — an
    `OPTIONS` request that carries both an allowed `Origin` and an
    `Access-Control-Request-Method`. Browsers cannot attach the capability
    header to a preflight, so refusing it would break the packaged client.

    Both halves of that test are load-bearing. Exempting every `OPTIONS`
    dispatched requests with **no `Origin` at all** to the application
    unauthenticated, because the origin check above only runs when an origin is
    present. The resource request that follows a real preflight is still
    authenticated normally.
    """

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
            await self._reject(
                scope_type, send, status=403, reason="Origin not allowed", origin=origin
            )
            return

        # Browsers cannot include the secret header in a preflight, so an
        # exact-origin CORS preflight may proceed; the resource request that
        # follows it remains authenticated. All three conditions are required —
        # an `OPTIONS` with no `Origin`, or with no requested method, is not a
        # preflight and must not reach the application unauthenticated.
        if (
            scope_type == "http"
            and scope.get("method") == "OPTIONS"
            and origin is not None
            and headers.get("access-control-request-method") is not None
        ):
            await self.app(scope, receive, send)
            return

        supplied = (
            headers.get(CAPABILITY_HEADER, "")
            if scope_type == "http"
            else _websocket_capability(headers)
        )
        # Compare bytes, not text. `compare_digest` raises `TypeError` on a
        # string containing a byte >= 0x80, and `supplied` is attacker-supplied
        # header content decoded as latin-1 — so a single high byte used to
        # escape this middleware as an unenveloped 500 instead of a 401.
        # Re-encoding as latin-1 reproduces the exact bytes that arrived.
        if not secrets.compare_digest(
            supplied.encode("latin-1", "replace"), self.capability.encode("utf-8")
        ):
            await self._reject(
                scope_type, send, status=401, reason="Authentication required", origin=origin
            )
            return
        await self.app(scope, receive, send)

    def _cors_headers(self, origin: str | None) -> list[tuple[bytes, bytes]]:
        """Echo the origin only when it is one this middleware already trusts.

        A rejection that advertised an untrusted origin would hand the caller the
        very boundary the rejection exists to enforce, so a 403 for a disallowed
        origin deliberately carries no CORS headers.
        """
        if origin is None or origin.rstrip("/") not in self.origins:
            return []
        return [
            (b"access-control-allow-origin", origin.encode("latin-1")),
            (b"access-control-allow-credentials", b"true"),
            (b"vary", b"Origin"),
        ]

    async def _reject(
        self,
        scope_type: str,
        send: Send,
        *,
        status: int,
        reason: str,
        origin: str | None,
    ) -> None:
        if scope_type == "websocket":
            # A close frame carries no headers, so CORS cannot be expressed here.
            # Browsers do not apply CORS to the WebSocket handshake either.
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
                    *self._cors_headers(origin),
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
