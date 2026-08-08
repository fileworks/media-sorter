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

Desktop state uses the stable `MediaSorter` platform config, non-roaming data,
and log roots. Override those roles with `MEDIASORT_CONFIG_DIR`,
`MEDIASORT_DATA_DIR`, `MEDIASORT_DB_PATH`, and `MEDIASORT_LOG_DIR`. The Docker
image maps all state to `/config` explicitly. Exact current/legacy paths,
non-destructive migration behavior, and recovery filenames are documented in
[state-and-recovery.md](../docs/state-and-recovery.md).

Override any configuration field with `MEDIASORT_<FIELD_UPPER>`:

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
| `_undated/` | No usable date could be established |
| `_corrupted/` | The file could not be read, placed, or repaired |
| `_junk/` | Thumbnail or cache debris |
| `<keeper folder>/_copies/` | Another copy of the keeper in that folder |

An exact match already present in the destination is reported without another write.
Legacy review-folder names remain recognised but new runs never create them.
