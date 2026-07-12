# MediaSorter Backend

Python **FastAPI** server for intelligent media organisation.  
Extracts dates from EXIF / video metadata / filenames, sorts files into a date-based folder
structure, and persists an operation history in SQLite.

---

## Quick Start

```bash
# Install dependencies (from project root)
make install

# Start the development server (hot-reload)
make backend
# → http://localhost:8000
# → API docs: http://localhost:8000/api/docs
```

---

## Installation (manual)

```bash
cd backend
python -m pip install -e ".[dev]"
```

Requires **Python 3.10+**.

---

## Development Commands

```bash
make backend           # Start FastAPI with hot-reload
make test              # Run all tests
make test-cov          # Tests + HTML coverage report
make test-unit         # Unit tests only (test_services/)
make test-integration  # API integration tests (test_api/)
make test-e2e          # End-to-end workflow tests
make lint              # Ruff lint + format check
make typecheck         # mypy strict type checking
make format            # Auto-format code
make ci                # Backend CI gate (lint + typecheck + test-ci)
```

---

## Configuration

Stored as `config.json` in the platform config dir (macOS: `~/Library/Application Support/mediasort/`; Linux/Docker: `~/.config/mediasort/`; override with `MEDIASORT_CONFIG_DIR`). Override any field with `MEDIASORT_<FIELD_UPPER>`:

```bash
MEDIASORT_SOURCE_DIRECTORY=/Volumes/Photos make backend
MEDIASORT_COPY_INSTEAD_OF_MOVE=true make backend
```

---

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/config` | Get current config |
| POST | `/api/config` | Update config (partial merge) |
| POST | `/api/config/validate` | Validate without saving |
| POST | `/api/scan` | List media files in source |
| POST | `/api/preview` | Dry-run preview of sort |
| POST | `/api/sorting/start` | Start sort; returns `task_id` |
| GET | `/api/sorting/{task_id}` | Poll sort progress |
| POST | `/api/sorting/{task_id}/cancel` | Cancel running sort |
| GET | `/api/sorting/{task_id}/report` | Get raw sort result dict |
| GET | `/api/reports` | List past operations (paginated) |
| GET | `/api/reports/{operation_id}` | Historical operation detail |
| POST | `/api/reports/{operation_id}/export` | Export CSV or JSON |
| WS | `/api/logs` | Live structured log stream |

Full interactive docs: **http://localhost:8000/api/docs**

---

## Testing

```bash
# All tests
pytest tests/ -v

# With coverage gate (≥80%)
pytest tests/ --cov=app --cov-report=html --cov-fail-under=80

# By layer
pytest tests/test_services/ -v     # unit
pytest tests/test_api/     -v     # integration
pytest tests/test_e2e/     -v -s  # end-to-end
```

---

## Quarantine Strategy

Files that cannot be placed in the normal date structure are quarantined (never deleted):

| Folder | Reason |
|--------|--------|
| `_unknown_dates/` | No date could be extracted |
| `_future_dates/` | Extracted date is after today (UTC) |
| `_duplicates/` | Content duplicate of another file in the same run (SHA-256 / perceptual) |
| `_failed/` | File operation raised an exception |
| `_corrupted/` | Post-copy validation failed and repair did not succeed |
