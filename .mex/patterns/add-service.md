---
name: add-service
description: Adding a new backend service to MediaSorter. Covers class structure, ServiceContainer registration, DI wiring, and testing approach.
triggers:
  - "add service"
  - "new service"
  - "service layer"
  - "ServiceContainer"
edges:
  - target: context/conventions.md
    condition: always load for verify checklist
  - target: context/architecture.md
    condition: when understanding where the new service fits in the pipeline
  - target: patterns/add-endpoint.md
    condition: when the service also needs a new API route
last_updated: 2026-06-21
---

# Add Service

## Context

All services live in `backend/app/services/`. Each is a plain Python class instantiated by `ServiceContainer` (`backend/app/core/bootstrap.py`) as a lazy singleton. Services receive their dependencies via `__init__` — no module-level singletons, no direct instantiation in routes.

## Steps

1. **Create the service file** in `backend/app/services/` (name it after the domain, e.g. `conversion_service.py`):
   ```python
   """One-line description of what this service does."""
   from __future__ import annotations

   import asyncio
   from pathlib import Path

   from backend.app.core.logging_config import get_logger

   logger = get_logger(__name__)


   class MyService:
       def __init__(self, dependency: SomeOtherService) -> None:
           self._dependency = dependency

       async def do_thing(self, path: Path) -> str:
           result = await asyncio.to_thread(self._blocking_work, path)
           return result

       def _blocking_work(self, path: Path) -> str:
           # CPU/file I/O goes here — called from a worker thread
           ...
   ```

2. **Register in `ServiceContainer`** (`backend/app/core/bootstrap.py`):
   - Add a `_my_service: MyService | None = None` slot in `__init__`
   - Add the type import under `if TYPE_CHECKING:`
   - Add a `@property` that lazy-initialises and caches the service:
   ```python
   @property
   def my_service(self) -> "MyService":
       if self._my_service is None:
           from backend.app.services.my_service import MyService
           self._my_service = MyService(dependency=self.some_other_service)
           self._logger.debug("Initialized MyService")
       return self._my_service
   ```

3. **Inject into callers** via the container property — never import and instantiate directly in routes or other services:
   ```python
   # In a route handler
   container = get_container(request)
   result = await container.my_service.do_thing(path)

   # In another service (receive via __init__, stored as self._my_service)
   ```

4. **Write unit tests** with a mocked dependency:
   ```python
   def test_my_service_does_thing():
       mock_dep = MagicMock(spec=SomeOtherService)
       svc = MyService(dependency=mock_dep)
       # test with mock_dep.method.return_value = ...
   ```

## Gotchas

- **Always `asyncio.to_thread` for blocking work.** Any file read, ffmpeg call, or CPU-intensive computation that isn't naturally async must go through `asyncio.to_thread`. Blocking the event loop from a service method stalls all concurrent progress polling.
- **Services are process-lifetime singletons.** State held on a service instance persists across requests. Don't store per-request state on the service; pass it as arguments instead.
- **Avoid circular dependencies.** The container builds services lazily, but if Service A initialises Service B and Service B initialises Service A, you'll get infinite recursion. Look for an existing shared dependency to inject instead.
- **Config is not re-read from disk.** The service receives `Config` at init time. If the user saves new config, `POST /api/config` propagates the new object via `container._my_service._config = new_config` — add that line to the config route if your service holds a config reference.
- **AI services need a `None` guard.** If your service depends on `container.encoder`, it may be `None` when hardware is below the minimum tier or fastembed isn't installed. Handle `None` gracefully.

## Verify

- [ ] Service class is in `backend/app/services/`; AI-specific in `backend/app/services/ai/`
- [ ] Lazy singleton registered in `ServiceContainer.__init__` (slot) and as a `@property`
- [ ] `if TYPE_CHECKING:` import used so the type hint doesn't create a circular import at runtime
- [ ] Blocking I/O goes through `asyncio.to_thread`; the public method is `async def`
- [ ] Unit tests mock dependencies at the service boundary, not at the filesystem level
- [ ] All verify items from `context/conventions.md` pass

## Update Scaffold
- [ ] Update `.mex/ROUTER.md` "Current Project State" if what's working/not built has changed
- [ ] Update `.mex/context/architecture.md` "Key Components" if the new service is significant
- [ ] If this is a new task type without a pattern, create one in `.mex/patterns/` and add to `.mex/patterns/INDEX.md`
