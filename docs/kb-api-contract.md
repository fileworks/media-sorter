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
| 400 | `CONFIG_ERROR` | invalid non-source config for an operation |
| 404 | `TASK_NOT_FOUND` / `OPERATION_NOT_FOUND` / `FILE_NOT_FOUND` | unknown id/path |
| 409 | `CONFLICT` | second concurrent long operation; report requested before completion |
| 415 | `UNSUPPORTED_MEDIA` | thumbnail/diff on an unreadable or unsupported file (client falls back to a placeholder) |
| 422 | `CONFIG_VALIDATION_ERROR` / `SOURCE_UNAVAILABLE` / `PATH_OVERLAP` | invalid config body, unavailable source, or overlapping paths |
| 500 | `INTERNAL_ERROR` / `SORTING_ERROR` / … | unhandled or operation failure |
| 503 | `ENCODER_UNAVAILABLE` | AI endpoint with no local encoder (tier off / model missing) |
| 507 | `INSUFFICIENT_STORAGE` | destination volume can't hold the copy |

Never raise bare `HTTPException` — subclass `MediaSortException` so the envelope stays uniform.

## Response Models
- Declare `response_model` on endpoints with stable shapes (`HealthResponse`, `HardwareResponse`, `AnalysisResponse`, `TaskProgressResponse`, …)
- **Documented dict exceptions**: the config blob (`GET/POST /config`), report payloads, and preview payloads are returned as `dict` on purpose — their shapes track the sort pipeline and a mirror model would silently drop new fields. Each such route carries a comment saying so
- `TaskProgressResponse` (`api/schemas.py`) is shared by analysis, scan, preview, and sort polling endpoints so they cannot drift

## Long-running Operations
1. `POST /{analysis|scan|preview}/start` or `/sorting/start` accepts a caller
   `idempotency_key` and promptly returns the task identity. Replaying the same
   kind/key returns that task; a different start while any operation is active
   returns 409 with the active task identity and kind.
2. Poll the matching task URL with optional `after_sequence`. The response
   includes operation kind, status, phase-local progress, ordered bounded events,
   partial issues, and a terminal result or structured failure.
3. POST the matching `/{task_id}/cancel` route. Cancellation is idempotent and
   cooperative: blocking traversal/signature work observes a thread-safe token;
   an in-flight verified file operation is allowed to finish consistently.
4. `GET /sorting/{task_id}/report` → 409 while not completed, 404 if completed without a result.

Video preview items can report `duplicate_evaluation: "unknown"` with
`duplicate_unknown_reason: "video_perceptual_not_computed"`. Their final
destination is deliberately omitted because the real sort performs the
authoritative frame comparison.

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
