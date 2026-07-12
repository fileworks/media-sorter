"""Typed dependency-injection accessors for request-scoped application state.

Starlette exposes ``request.app.state`` attributes as ``Any``, which erases the
types of the service container and config and forces every handler to either
re-annotate locally or sprinkle ``# type: ignore``. These helpers recover the
real types in one place, and the ``Annotated`` aliases below let routes declare
their dependencies via ``Depends`` (Hard Rule 6) instead of reaching into a bare
``Request``:

    @router.post("/scan")
    async def scan(container: ContainerDep, config: ConfigDep): ...
"""

from typing import Annotated

from fastapi import Depends, Request

# Imported at runtime (not under TYPE_CHECKING) so FastAPI can resolve the
# ``Annotated`` aliases below when it introspects route signatures. Neither
# module imports this one at top level, so there is no import cycle.
from app.core.bootstrap import ServiceContainer
from app.core.config import Config


def get_container(request: Request) -> ServiceContainer:
    container: ServiceContainer = request.app.state.container
    return container


def get_config(request: Request) -> Config:
    # The container is the single source of truth for the active config; reading
    # it here (rather than app.state) keeps every consumer in sync after a save.
    return get_container(request).config


ContainerDep = Annotated[ServiceContainer, Depends(get_container)]
ConfigDep = Annotated[Config, Depends(get_config)]
