<!-- scope: Backend pytest rules and patterns AS USED IN THIS REPO -->

## Backend Testing (Python / pytest)

### Setup
- `pytest-asyncio` with `asyncio_mode = "auto"` (in `pyproject.toml`) — async tests need no marker
- HTTP integration tests use **`fastapi.testclient.TestClient`** via the shared `client` fixture (sync client against the async app is the repo norm)
- Coverage gate: **≥80%** (`make test-ci` / `make ci`); run subsets with `make test-unit` / `make test-integration` / `make test-e2e`

### Layout
| Directory | Kind | Talks to |
|---|---|---|
| `tests/test_services/` | unit | service classes directly (mock collaborators) |
| `tests/test_api/` | integration | HTTP via `TestClient`, real temp DB |
| `tests/test_e2e/` | end-to-end | full sort workflow over the API |
| `tests/test_utils/` | unit | pure helpers |
| `tests/test_config.py`, `test_database.py`, … | unit | core modules |

### Shared fixtures (`tests/conftest.py`)
- `test_config` — a `Config` pointed at temp dirs (never the real user config)
- `app` / `client` — `AppFactory.create(test_config)` + `TestClient`; DB isolation is asserted (`_assert_db_isolated`)
- `in_memory_db` / `test_db` — `DatabaseManager` at a `tmp_path` (via `MEDIASORT_DB_PATH`)
- `sample_jpeg_with_exif`, `sample_corrupted_image`, `sample_directory_with_images`, … — real media files generated with PIL/piexif

### Patterns
- **Optional deps**: guard with `pytest.importorskip("PIL.Image")` — the `[local-ai]` extra is absent in CI, and all AI model code must stay testable through injected fakes (fake encoders / sessions / tokenizers; see `test_siglip_encoder.py`, `test_ai_tagging_service.py`)
- **Mock at the collaborator boundary** with `unittest.mock.patch.object(svc._extraction, "extract_detailed", ...)` — not whole services when testing a route
- **Background tasks**: use the real typed `Task` when phase/event/partial behavior matters; focused legacy service tests may use a progress/cancel stand-in. Worker-thread cancellation and retention/idempotency behavior belong in `test_task_manager.py`.
- `pytest.mark.parametrize` for edge-case tables (see `test_config.py` rename-pattern tests)
- Never touch the network — the update checker and cloud taggers are tested with mocked `httpx`

## Coverage Goals
- Services (business logic): the focus of the ≥80% gate
- Routes: covered by `tests/test_api/` happy-path + error-contract tests (404/409/422/415)

## ⚠️ Never
- Never test private internals — test behaviour through the public method/route
- Never let a test read or write the real user config/DB (fixtures redirect via env vars)
- Never skip error paths — every route's error contract has a test
- Never require the `local-ai` extra — inject fakes, `importorskip` real-model paths
- Never leave `@pytest.mark.skip`/`only`-style filters in committed tests
