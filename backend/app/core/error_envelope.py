"""Emit the error envelope for unhandled exceptions from inside the CORS wrapper.

Starlette serves ``@app.exception_handler(Exception)`` from ``ServerErrorMiddleware``,
which is always the outermost middleware — outside ``CORSMiddleware``. A 500 produced
there reaches the browser without CORS headers, so the interface sees an opaque
network failure instead of a server fault. Registering this middleware inside the CORS
layer keeps the envelope and the headers together.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Protocol

from starlette.types import Message, Receive, Scope, Send

_BODY = b'{"error":"Internal server error","code":"INTERNAL_ERROR"}'


class ErrorLogger(Protocol):
    """The one method needed here, so structlog and stdlib loggers both fit."""

    def error(self, event: str, *args: object, **kwargs: object) -> object: ...


class ExceptionEnvelopeMiddleware:
    """Return the ``{"error", "code"}`` envelope for otherwise unhandled exceptions."""

    def __init__(
        self,
        app: Callable[[Scope, Receive, Send], Awaitable[None]],
        *,
        logger: ErrorLogger,
    ) -> None:
        self.app = app
        self.logger = logger

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        started = False

        async def _send(message: Message) -> None:
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            await self.app(scope, receive, _send)
        except Exception:
            self.logger.error("Unhandled exception", exc_info=True)
            if started:
                # The status line is already on the wire; only the outer server
                # error middleware can decide what happens to a truncated body.
                raise
            await send(
                {
                    "type": "http.response.start",
                    "status": 500,
                    "headers": [
                        (b"content-type", b"application/json"),
                        (b"content-length", str(len(_BODY)).encode("ascii")),
                    ],
                }
            )
            await send({"type": "http.response.body", "body": _BODY})
