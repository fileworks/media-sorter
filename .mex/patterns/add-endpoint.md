---
name: add-endpoint
description: Adding a new FastAPI route to the MediaSorter backend. Covers route creation, DI wiring, error handling, and registration.
triggers:
  - "add route"
  - "add endpoint"
  - "new API"
  - "new route"
edges:
  - target: context/conventions.md
    condition: always load for verify checklist before writing route code
  - target: context/architecture.md
    condition: when deciding which service to call from the route
  - target: patterns/add-service.md
    condition: when the new endpoint needs a service that doesn't exist yet
last_updated: 2026-07-02
---

# Add Endpoint

## Context

Routes live in `backend/app/api/routes/`. Each file covers one domain (`config.py`, `sorting.py`, `media.py`, `logs.py`, `scan.py`, `health.py`, `reports.py`, `ai.py`, `update.py`). A route handler should be 5–15 lines — business logic lives in the service layer.

Load: `context/conventions.md` (Verify Checklist) and `context/architecture.md` (which service to use).

## Steps

1. **Choose the right route file** — find the domain file in `backend/app/api/routes/` that matches (e.g., config changes → `config.py`, sort operations → `sorting.py`). If no file fits, create a new one and register it in `_include_routes()` in `backend/app/core/bootstrap.py`.

2. **Define request/response models** in the same route file using `pydantic.BaseModel`:
   ```python
   class MyRequest(BaseModel):
       some_field: str
       optional_field: int = 0

   class MyResponse(BaseModel):
       result: str
       count: int
   ```

3. **Write the route handler** — inject the container/config via the typed `Depends`
   aliases (`ContainerDep` / `ConfigDep` from `app.api.deps`), call the service, raise
   typed exceptions. Never inject a bare `Request` (CLAUDE.md Hard Rule 6):
   ```python
   from app.api.deps import ConfigDep, ContainerDep

   @router.post("/my-endpoint", response_model=MyResponse)
   async def my_endpoint(body: MyRequest, container: ContainerDep) -> MyResponse:
       result = await container.my_service.do_thing(body.some_field)
       return MyResponse(result=result, count=1)
   ```
   Need the active config too? Add `config: ConfigDep`. Shared response shapes
   (e.g. `TaskProgressResponse`) live in `backend/app/api/schemas.py`; route-specific ones
   stay in the route file.

4. **Use typed exceptions** from `backend/app/core/exceptions.py` — never construct `HTTPException` directly:
   ```python
   # Correct
   raise TaskNotFoundError(task_id)
   raise ConfigError("source_directory is required")
   raise ConflictError("Operation already in progress")

   # Wrong
   raise HTTPException(status_code=404, detail="Not found")
   ```

5. **If the route file is new**, register it in `backend/app/core/bootstrap.py`:
   ```python
   # In _include_routes():
   from backend.app.api.routes import my_module
   app.include_router(my_module.router, prefix="/api", tags=["my-tag"])
   ```

6. **Write tests** — add an integration test in `backend/tests/test_api/` (if the directory exists) or a unit test mocking the service. See `docs/kb-testing.md`.

## Gotchas

- `ContainerDep` (`Annotated[ServiceContainer, Depends(get_container)]`) is the way to access services from routes — never instantiate a service directly in a handler, and never inject a bare `Request`.
- Need the active config? Inject `ConfigDep` — it reads from the container (the single source of truth), so it stays correct after a save.
- Long-running operations (sort, preview, analysis) must be wrapped in `TaskManager.create_task()` and polled — never `await` a multi-second operation directly in a route handler.
- `response_model=` is required for stable, fully-known shapes (CLAUDE.md rule 1). For large/evolving payloads (the full config blob, reports, preview) `dict[str, Any]` is the deliberate choice — a strict `response_model` silently drops any field not mirrored. Document the `dict` return inline.
- If a route mutates `Config`, call `container.set_config(new_config)` — the one public method that persists nothing but re-points every already-initialised service. Never poke `container._service._config` from a route.

## Verify

- [ ] Route handler delegates to a service — no business logic inline
- [ ] `response_model` is declared on the decorator
- [ ] Errors raise `MediaSortException` subclasses, not `HTTPException`
- [ ] Long-running work uses `TaskManager`, not a bare `await`
- [ ] New route files are registered in `_include_routes()` in `backend/app/core/bootstrap.py`
- [ ] All verify items from `context/conventions.md` pass

## Update Scaffold
- [ ] Update `.mex/ROUTER.md` "Current Project State" if what's working/not built has changed
- [ ] Update any `.mex/context/` files that are now out of date
- [ ] If this is a new task type without a pattern, create one in `.mex/patterns/` and add to `.mex/patterns/INDEX.md`
