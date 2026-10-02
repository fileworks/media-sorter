"""Config service — read access to the live Config for services.

Config *mutation* lives in one place: the ``POST /config`` route, which merges,
validates, persists and propagates via ``ServiceContainer.set_config``.
"""

from app.core.config import Config


class ConfigService:
    def __init__(self, config: Config) -> None:
        self._config = config

    def get(self) -> Config:
        return self._config
