"""Shared log broadcast bus for the /api/logs WebSocket endpoint.

Each WebSocket connection gets its own queue and receives every log entry
emitted by the structlog ``LogQueueBroadcast`` processor. The legacy single
global queue is kept as a no-op fan-out target so existing call sites that
push to ``get_queue()`` continue to work.
"""

import asyncio
import contextlib
from typing import Any

# Per-connection subscriber queues. Mutated only from the main event loop.
_subscribers: set["asyncio.Queue[dict[str, Any]]"] = set()


# Legacy single-broadcast queue retained for back-compat. ``LogQueueBroadcast``
# pushes to ``get_queue()`` which now forwards into every subscriber.
class _BroadcastQueue:
    """Quacks like ``asyncio.Queue`` enough for the LogQueueBroadcast processor.

    ``put_nowait`` fans the entry out into every subscriber's queue.
    ``full()`` / ``get_nowait()`` exist so the drop-oldest ring-buffer path in
    ``LogQueueBroadcast`` does not error.
    """

    def __init__(self, maxsize: int) -> None:
        # Cap per-subscriber backlog at the same size.
        self.maxsize = maxsize

    def full(self) -> bool:
        # The broadcast bus itself never blocks — per-subscriber backpressure
        # is handled in put_nowait below.
        return False

    def get_nowait(self) -> dict[str, Any]:  # pragma: no cover — never called
        raise asyncio.QueueEmpty

    def put_nowait(self, entry: dict[str, Any]) -> None:
        # Fan out. If a subscriber is slow/full, drop its oldest entry first
        # (ring buffer per subscriber) rather than blocking the broadcaster.
        for q in list(_subscribers):
            if q.full():
                with contextlib.suppress(asyncio.QueueEmpty):
                    q.get_nowait()
            with contextlib.suppress(Exception):
                q.put_nowait(entry)


_BUS = _BroadcastQueue(maxsize=1000)


def get_queue() -> _BroadcastQueue:
    """Return the broadcast bus (back-compat name)."""
    return _BUS


def subscribe(maxsize: int = 1000) -> "asyncio.Queue[dict[str, Any]]":
    """Register a new per-connection queue. Caller must call ``unsubscribe``."""
    q: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=maxsize)
    _subscribers.add(q)
    return q


def unsubscribe(q: "asyncio.Queue[dict[str, Any]]") -> None:
    """Detach a subscriber queue."""
    _subscribers.discard(q)


def subscriber_count() -> int:
    """Return the current number of subscribers (for debugging/tests)."""
    return len(_subscribers)
