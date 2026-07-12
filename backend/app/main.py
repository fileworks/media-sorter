"""FastAPI application entry point."""

import os
import sys

from app.core.bootstrap import AppFactory
from app.core.logging_config import get_logger

app = AppFactory.create()
logger = get_logger(__name__)

if __name__ == "__main__":
    import socket

    import uvicorn

    port = int(os.getenv("MEDIASORT_PORT", "8000"))
    log_level = os.getenv("MEDIASORT_LOG_LEVEL", "info")
    debug = os.getenv("MEDIASORT_DEBUG", "false").lower() == "true"

    logger.info("Starting server", port=port, log_level=log_level, debug=debug)

    # Check if port is available before attempting to bind.
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            sock.bind(("127.0.0.1", port))
    except OSError as e:
        logger.error(
            f"Port {port} is not available: {e}. "
            "Another application may be using this port. "
            "The launcher will retry with a different port."
        )
        sys.exit(1)

    # When running as a PyInstaller-frozen executable, uvicorn cannot resolve
    # "app.main:app" as a string module path (no filesystem module lookup).
    # Detect the frozen context and pass the app object directly instead.
    # reload=True is also incompatible with frozen mode, so it's omitted there.
    if getattr(sys, "frozen", False):
        uvicorn.run(
            app,
            host="127.0.0.1",
            port=port,
            log_level=log_level,
        )
    else:
        uvicorn.run(
            "app.main:app",
            host="127.0.0.1",
            port=port,
            log_level=log_level,
            reload=debug,
        )
