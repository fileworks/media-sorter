"""WebSocket log streaming route."""

import asyncio
import contextlib
import json
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.core.api_security import websocket_protocol
from app.core.log_queue import subscribe, unsubscribe

router = APIRouter()


@router.websocket("/logs")
async def log_stream(websocket: WebSocket) -> None:
    await websocket.accept(subprotocol=websocket_protocol(websocket.headers))
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
