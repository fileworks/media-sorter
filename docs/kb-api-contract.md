<!-- scope: HTTP conventions, error envelope, status codes, pagination AS USED IN THIS REPO -->

## Shape of the API
- Single prefix **`/api`** — no versioning. The frontend ships inside the same Tauri bundle as the backend, so there is never a compatibility window to bridge
- **`snake_case` JSON everywhere** (fields mirror the Python names); the TypeScript client (`frontend/src/services/api.ts`) declares the same shapes — no camelCase aliasing layer
- OpenAPI served at `/api/openapi.json`, interactive docs at `/api/docs`
- Localhost-only, single-user desktop backend: **no auth** by design; reading arbitrary local paths (thumbnails, media info) is intentional

## Error Envelope
Every error goes through the global `MediaSortException` handler:

```json
{ "error": "Task 'abc' not found", "code": "TASK_NOT_FOUND", "details": { "task_id": "abc" } }
```

| Status | Code | Raised by |
|---|---|---|
| 400 | `CONFIG_ERROR` | missing/invalid config for an operation |
| 404 | `TASK_NOT_FOUND` / `OPERATION_NOT_FOUND` / `FILE_NOT_FOUND` | unknown id/path |
| 409 | `CONFLICT` | second concurrent sort; report requested before completion |
| 415 | `UNSUPPORTED_MEDIA` | thumbnail/diff on an unreadable or unsupported file (client falls back to a placeholder) |
| 422 | `CONFIG_VALIDATION_ERROR` | `POST /config` body with unknown keys or incoercible values |
| 500 | `INTERNAL_ERROR` / `SORTING_ERROR` / … | unhandled or operation failure |
| 503 | `ENCODER_UNAVAILABLE` | AI endpoint with no local encoder (tier off / model missing) |
| 507 | `INSUFFICIENT_STORAGE` | destination volume can't hold the copy |

Never raise bare `HTTPException` — subclass `MediaSortException` so the envelope stays uniform.

## Response Models
- Declare `response_model` on endpoints with stable shapes (`HealthResponse`, `HardwareResponse`, `AnalysisResponse`, `TaskProgressResponse`, …)
- **Documented dict exceptions**: the config blob (`GET/POST /config`), report payloads, and preview payloads are returned as `dict` on purpose — their shapes track the sort pipeline and a mirror model would silently drop new fields. Each such route carries a comment saying so
- `TaskProgressResponse` (`api/schemas.py`) is shared by the sort and preview polling endpoints so they can never drift

## Long-running Operations
1. `POST /sorting/start` (or `/preview/start`) → `{"task_id"}`; a second concurrent sort → 409
2. Poll `GET /sorting/{task_id}` → `TaskProgressResponse` (`status`, `progress.{current,total,percentage,phase,estimated_time_remaining_seconds}`, terminal `result`)
3. `POST /sorting/{task_id}/cancel` → cooperative: returns `{"status": "cancelled"}` immediately; the task finishes its in-flight file, then persists the partial run
4. `GET /sorting/{task_id}/report` → 409 while not completed, 404 if completed without a result

## Pagination
`GET /reports` uses bounded limit/offset — SQLite reads `LIMIT -1` as unbounded, so bounds live at the query layer:

```python
limit: int = Query(default=20, ge=1, le=500)
offset: int = Query(default=0, ge=0)
```

Response: `{"operations": [...], "total": n, "limit": l, "offset": o}`.

## CORS & WebSocket Origins
- CORS (bootstrap.py): explicit `localhost`/`127.0.0.1` + the three Tauri origins (`tauri://localhost`, `https://tauri.localhost`, `http://tauri.localhost`) + a regex for any `localhost:<port>` Vite dev server
- Browsers do **not** apply CORS to WebSocket handshakes → `/api/logs` does its own anchored origin check (`^http://(localhost|127\.0\.0\.1)(:\d+)?$` — a bare `startswith` would accept `localhost.attacker.com`)

## File Downloads
Report export returns `StreamingResponse` with `Content-Disposition: attachment` and exposes the header via `Access-Control-Expose-Headers` so the frontend can read the filename.

## ⚠️ Never
- Never skip `response_model` on a stable-shape endpoint; never add an undocumented dict return
- Never mix naming styles — this API is `snake_case`, end to end
- Never return an unbounded list — bound pagination params at the query layer
- Never expose secrets (cloud API keys are accepted in config but never echoed into logs)
- Never use `Any` in Pydantic schema fields
- Never trust client-side validation alone — `POST /config` re-validates every key server-side
