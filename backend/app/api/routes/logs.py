"""WebSocket log streaming route."""

import asyncio
import contextlib
import json
import re
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.core.log_queue import subscribe, unsubscribe

router = APIRouter()


_ALLOWED_ORIGINS = (
    "tauri://localhost",
    "https://tauri.localhost",
    "http://tauri.localhost",
)
# Anchored so only http://localhost[:port] / http://127.0.0.1[:port] match — a
# bare ``startswith`` would also accept http://localhost.attacker.com. Browsers
# don't apply CORS to WebSocket handshakes, so this server-side check is the
# only gate. Mirrors the CORS regex in bootstrap.py.
_LOCAL_ORIGIN_RE = re.compile(r"^http://(localhost|127\.0\.0\.1)(:\d+)?$")


def _is_origin_allowed(origin: str | None) -> bool:
    """Return True for local / Tauri origins (or no origin = non-browser client)."""
    if origin is None:
        return True  # non-browser client (CLI, test) — allow
    if origin in _ALLOWED_ORIGINS:
        return True
    return bool(_LOCAL_ORIGIN_RE.match(origin))


@router.websocket("/logs")
async def log_stream(websocket: WebSocket) -> None:
    origin = websocket.headers.get("origin")
    if not _is_origin_allowed(origin):
        await websocket.close(code=1008, reason="Origin not allowed")
        return
    await websocket.accept()
    # Per-connection queue so opening multiple tabs/windows doesn't make them
    # compete for the same single broadcast queue. The structlog processor
    # fans new entries into every subscriber via app.core.log_queue.
    queue = subscribe()
    try:
        await _run_until_closed(websocket, queue)
    finally:
        unsubscribe(queue)


async def _run_until_closed(websocket: WebSocket, queue: "asyncio.Queue[Any]") -> None:
    """Forward log entries until the socket closes.

    A send-only handler that merely awaits the queue can't tell the client has
    gone until its *next* send fails (up to the ping interval later), so it
    lingers as an idle task. That stray task made uvicorn's graceful shutdown
    time out ("Cancel 1 running task(s)"). Watching the socket for a disconnect
    concurrently lets the handler exit immediately — on client close *and* on
    the server-initiated close during shutdown — keeping teardown clean.
    """
    send_task = asyncio.create_task(_send_loop(websocket, queue))
    recv_task = asyncio.create_task(_watch_for_disconnect(websocket))
    try:
        await asyncio.wait({send_task, recv_task}, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for task in (send_task, recv_task):
            task.cancel()
        for task in (send_task, recv_task):
            # CancelledError is a BaseException (not Exception), so list it
            # explicitly; swallow the rest since this is teardown.
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task


async def _send_loop(websocket: WebSocket, queue: "asyncio.Queue[Any]") -> None:
    while True:
        try:
            entry = await asyncio.wait_for(queue.get(), timeout=30.0)
            await websocket.send_text(json.dumps(entry))
        except asyncio.TimeoutError:
            # Keepalive ping so idle connections (and proxies) stay open.
            await websocket.send_text(json.dumps({"type": "ping"}))


async def _watch_for_disconnect(websocket: WebSocket) -> None:
    # We don't expect inbound messages; this exists solely to observe the
    # close. receive() raises WebSocketDisconnect when the socket goes away.
    try:
        while True:
            await websocket.receive()
    except WebSocketDisconnect:
        return
