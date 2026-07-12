"""Structured logging configuration via structlog."""

import asyncio
import contextlib
import logging
import logging.handlers
import os
import platform
import sys
from collections.abc import MutableMapping
from pathlib import Path
from typing import Any, cast

import structlog

# The event loop running the FastAPI app. Captured at startup so cross-thread
# log calls (e.g. from asyncio.to_thread workers in SortingService) can hand
# entries back to the loop via call_soon_threadsafe — asyncio.Queue is NOT
# thread-safe, so a worker thread must never put onto it directly.
_main_loop: asyncio.AbstractEventLoop | None = None


def _get_log_dir() -> Path:
    """Return the OS-appropriate log directory for MediaSorter, creating it if needed."""
    system = platform.system()
    if system == "Darwin":
        log_dir = Path.home() / "Library" / "Logs" / "MediaSorter"
    elif system == "Windows":
        # Prefer LocalAppData — logs are ephemeral and should not roam to domain servers.
        appdata = os.environ.get("LOCALAPPDATA") or os.environ.get("APPDATA") or str(Path.home())
        log_dir = Path(appdata) / "MediaSorter" / "logs"
    else:
        xdg = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
        log_dir = Path(xdg) / "mediasort" / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    return log_dir


def _to_jsonable(value: Any) -> Any:
    """Coerce a structlog context value into something json.dumps can serialise."""
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    if isinstance(value, (list, tuple)):
        return [_to_jsonable(v) for v in value]
    if isinstance(value, dict):
        return {str(k): _to_jsonable(v) for k, v in value.items()}
    return str(value)  # Path, Exception, ImageHash, bytes, datetime, …


class LogQueueBroadcast:
    """Structlog processor that pushes log entries to the WebSocket broadcast queue.

    Must be inserted AFTER TimeStamper and add_log_level so those fields are
    already present, but BEFORE JSONRenderer so event_dict is still a dict.
    Normalises structlog's 'event' key to 'message' for the frontend contract.
    Carries all extra context fields as a JSON-safe 'context' dict.
    """

    _RESERVED = {"event", "timestamp", "level", "logger", "level_number"}

    def __call__(
        self, logger: Any, method: str, event_dict: MutableMapping[str, Any]
    ) -> MutableMapping[str, Any]:
        context = {k: _to_jsonable(v) for k, v in event_dict.items() if k not in self._RESERVED}
        entry = {
            "timestamp": event_dict.get("timestamp", ""),
            "level": event_dict.get("level", "info"),
            "message": event_dict.get("event", ""),
            "context": context or None,
        }
        try:
            from app.core.log_queue import get_queue

            q = get_queue()
            # asyncio.Queue is not thread-safe; structlog runs on whichever
            # thread emitted the log (per-file work runs on asyncio.to_thread
            # workers). Marshal the put onto the captured event loop.
            if _main_loop is not None and _main_loop.is_running():
                try:
                    asyncio.get_running_loop()
                    # On the loop thread — put directly (still drop-oldest on full).
                    _drop_oldest_put(q, entry)
                except RuntimeError:
                    _main_loop.call_soon_threadsafe(_drop_oldest_put, q, entry)
            else:
                # No loop yet (early startup) — best-effort direct put.
                _drop_oldest_put(q, entry)
        except Exception:
            pass
        return event_dict


def _drop_oldest_put(q: Any, entry: dict[str, Any]) -> None:
    """Push *entry* onto *q*; if full, drop the oldest entry first (ring buffer).

    Must only be called on the loop thread. ``q`` is typed loosely so the
    legacy ``_BroadcastQueue`` fan-out (which only quacks like asyncio.Queue)
    can be passed alongside real asyncio queues.
    """
    try:
        if q.full():
            with contextlib.suppress(asyncio.QueueEmpty):
                q.get_nowait()
        q.put_nowait(entry)
    except Exception:
        pass


def capture_main_loop() -> None:
    """Capture the currently-running event loop for thread-safe log dispatch.

    Call once from the FastAPI lifespan startup, after the loop is running.
    """
    global _main_loop
    try:
        _main_loop = asyncio.get_running_loop()
    except RuntimeError:
        _main_loop = None


def setup_logging(log_level: str = "INFO") -> None:
    """Configure structlog and stdlib logging, writing to stdout and a rotating log file."""
    numeric_level = getattr(logging, log_level.upper(), logging.INFO)

    structlog.configure(
        processors=[
            structlog.stdlib.filter_by_level,
            structlog.stdlib.add_logger_name,
            structlog.stdlib.add_log_level,
            structlog.stdlib.PositionalArgumentsFormatter(),
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.StackInfoRenderer(),
            structlog.processors.format_exc_info,
            structlog.processors.UnicodeDecoder(),
            LogQueueBroadcast(),
            structlog.processors.JSONRenderer(),
        ],
        context_class=dict,
        logger_factory=structlog.stdlib.LoggerFactory(),
        cache_logger_on_first_use=True,
    )

    root_logger = logging.getLogger()

    # Avoid double-registering handlers if setup_logging is called more than once.
    has_stream = any(
        isinstance(h, logging.StreamHandler) and not isinstance(h, logging.FileHandler)
        for h in root_logger.handlers
    )
    has_file = any(
        isinstance(h, logging.handlers.RotatingFileHandler) for h in root_logger.handlers
    )

    if not has_stream:
        logging.basicConfig(
            format="%(message)s",
            stream=sys.stdout,
            level=numeric_level,
        )
    # Always set the root level — basicConfig is a no-op when root already has
    # handlers (e.g. from pytest, uvicorn, or another library), so setLevel must
    # be called unconditionally rather than only in the else-branch.
    root_logger.setLevel(numeric_level)

    if not has_file:
        try:
            log_dir = _get_log_dir()
            file_handler = logging.handlers.RotatingFileHandler(
                log_dir / "backend.log",
                maxBytes=5 * 1024 * 1024,  # 5 MB per file
                backupCount=3,
                encoding="utf-8",
            )
            file_handler.setLevel(numeric_level)
            file_handler.setFormatter(logging.Formatter("%(message)s"))
            root_logger.addHandler(file_handler)
        except Exception:
            pass  # Never let logging setup crash the app
    else:
        # Level may have changed since the handler was first registered.
        for h in root_logger.handlers:
            if isinstance(h, logging.handlers.RotatingFileHandler):
                h.setLevel(numeric_level)

    logging.getLogger("uvicorn.access").setLevel(logging.INFO)
    logging.getLogger("uvicorn").setLevel(logging.INFO)


def get_logger(name: str) -> structlog.BoundLogger:
    """Return a bound structlog logger."""
    # structlog.get_logger is typed to return Any (it hands back a lazy proxy
    # that only resolves to a BoundLogger on first bind); cast to the concrete
    # type so callers get checked logging calls.
    return cast(structlog.BoundLogger, structlog.get_logger(name))
