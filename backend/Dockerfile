# ── Stage 1: builder ──────────────────────────────────────────────────────────
FROM python:3.11-slim AS builder

WORKDIR /build

# System deps for Pillow (JPEG, PNG, WebP), piexif, imagehash
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        libjpeg-dev \
        zlib1g-dev \
        libpng-dev \
        libwebp-dev \
    && rm -rf /var/lib/apt/lists/*

# hatchling reads pyproject.toml + README.md before installing,
# and the app package must be present for an editable-style build.
COPY pyproject.toml README.md ./
COPY app/ ./app/

RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir --prefix=/install .

# ── Stage 2: runtime ─────────────────────────────────────────────────────────
FROM python:3.11-slim

LABEL org.opencontainers.image.title="MediaSorter Backend"
LABEL org.opencontainers.image.description="FastAPI backend for intelligent media organisation"
LABEL org.opencontainers.image.version="0.1.0"

WORKDIR /app

# ffmpeg for video metadata extraction and remuxing
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
    && rm -rf /var/lib/apt/lists/*

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/app

# Copy installed packages from builder stage
COPY --from=builder /install /usr/local

# Copy application source
COPY app/ ./app/

# Non-root user for security; /config is the volume mount point
RUN useradd --system --uid 1000 --no-create-home mediasort && \
    mkdir -p /config && \
    chown -R mediasort:mediasort /app /config

USER mediasort

EXPOSE 8000

# Named volume for config.json and mediasort.db
VOLUME ["/config"]

ENV MEDIASORT_CONFIG_DIR=/config \
    MEDIASORT_DB_PATH=/config/mediasort.db

HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c \
        "import urllib.request, sys; sys.exit(0 if urllib.request.urlopen('http://localhost:8000/api/health').status == 200 else 1)"

CMD ["python", "-m", "uvicorn", "app.main:app", \
     "--host", "0.0.0.0", "--port", "8000", \
     "--workers", "1"]
