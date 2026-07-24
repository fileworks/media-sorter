"""Application bootstrap and dependency injection."""

from collections.abc import AsyncGenerator, Callable
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from typing import TYPE_CHECKING

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from structlog import BoundLogger

from app._version import __version__
from app.core.config import Config, ConfigLoader
from app.core.database import DatabaseManager
from app.core.exceptions import MediaSortException
from app.core.logging_config import capture_main_loop, get_logger, setup_logging

if TYPE_CHECKING:
    from app.background_tasks.task_manager import TaskManager
    from app.services.ai.ai_tagging_service import AITaggingService
    from app.services.ai.category_classifier_service import CategoryClassifierService
    from app.services.ai.category_suggestion_service import CategorySuggestionService
    from app.services.ai.encoder_protocol import VisionEncoder
    from app.services.ai.hardware import HardwareProfile
    from app.services.analysis_service import AnalysisService
    from app.services.config_service import ConfigService
    from app.services.conversion_service import ConversionService
    from app.services.duplicate_service import DuplicateService
    from app.services.extraction_service import DateExtractionService
    from app.services.filesystem_service import FileSystemService
    from app.services.metadata_service import MetadataService
    from app.services.preview_service import PreviewService
    from app.services.repair_service import RepairService
    from app.services.report_service import ReportService
    from app.services.rule_engine_service import RuleEngineService
    from app.services.sorting_service import SortingService
    from app.services.update_service import UpdateService


class ServiceContainer:
    """Centralized service instantiation and dependency injection.

    All services are lazy-initialised on first access and cached as singletons
    for the lifetime of the container.
    """

    def __init__(self, config: Config) -> None:
        self._config = config
        self._logger = get_logger(__name__)

        self.db_manager = DatabaseManager()
        self.db_manager.init_schema()

        # Lazy-initialised service slots
        self._config_service: ConfigService | None = None
        self._filesystem_service: FileSystemService | None = None
        self._extraction_service: DateExtractionService | None = None
        self._sorting_service: SortingService | None = None
        self._duplicate_service: DuplicateService | None = None
        self._metadata_service: MetadataService | None = None
        self._conversion_service: ConversionService | None = None
        self._repair_service: RepairService | None = None
        self._task_manager: TaskManager | None = None
        self._preview_service: PreviewService | None = None
        self._report_service: ReportService | None = None
        self._rule_engine_service: RuleEngineService | None = None
        self._hardware_profile: HardwareProfile | None = None
        self._encoder: VisionEncoder | None = None
        self._encoder_built = False
        self._ai_tagging_service: AITaggingService | None = None
        self._category_classifier_service: CategoryClassifierService | None = None
        self._category_suggestion_service: CategorySuggestionService | None = None
        self._analysis_service: AnalysisService | None = None
        self._update_service: UpdateService | None = None

    @property
    def config(self) -> Config:
        """The active config. Source of truth for all services in this container."""
        return self._config

    def set_config(self, config: Config) -> None:
        """Replace the active config and propagate it to live services.

        Lazy (not-yet-created) services pick up the new config at construction.
        The ones already initialised are re-pointed here so an in-flight or next
        operation never uses stale config. ``AITaggingService`` caches its
        provider/max_tags at construction, so it is rebuilt (cheap — the model
        loads lazily and the shared encoder is reused); the SortingService that
        holds it is re-pointed at the fresh instance. ``CategoryClassifierService``
        reads config live (caching only text embeddings keyed by the category
        list), so re-pointing is enough.

        Changing an *encoder-selecting* field (``ai_model_tier`` / ``ai_allow_gpu``)
        is special: the cached :class:`VisionEncoder` and every service that
        captured it are dropped so the new tier actually takes effect. They are
        not rebuilt here — building an encoder loads a model (blocking I/O), which
        must never run on the event loop — but lazily on next access, which always
        happens from a worker thread.
        """
        prev = self._config
        self._config = config
        if self._config_service is not None:
            self._config_service._config = config
        if self._rule_engine_service is not None:
            self._rule_engine_service._config = config
        if self._update_service is not None:
            self._update_service.set_enabled(config.update_check_enabled)

        encoder_changed = (
            prev.ai_model_tier != config.ai_model_tier or prev.ai_allow_gpu != config.ai_allow_gpu
        )
        if encoder_changed:
            self._encoder = None
            self._encoder_built = False
            self._ai_tagging_service = None
            self._category_classifier_service = None
            self._category_suggestion_service = None
            self._sorting_service = None
            self._preview_service = None
            return

        # Encoder unchanged — re-point the live services at the new config in place.
        if self._sorting_service is not None:
            self._sorting_service._config = config
        if self._category_classifier_service is not None:
            self._category_classifier_service._config = config
        if self._ai_tagging_service is not None:
            from app.services.ai.ai_tagging_service import AITaggingService

            fresh_ai = AITaggingService(config=config, embedder=self.encoder)
            self._ai_tagging_service = fresh_ai
            if self._sorting_service is not None:
                self._sorting_service._ai = fresh_ai

    @property
    def config_service(self) -> "ConfigService":
        if self._config_service is None:
            from app.services.config_service import ConfigService

            self._config_service = ConfigService(self._config)
            self._logger.debug("Initialized ConfigService")
        return self._config_service

    @property
    def filesystem_service(self) -> "FileSystemService":
        if self._filesystem_service is None:
            from app.services.filesystem_service import FileSystemService

            self._filesystem_service = FileSystemService()
            self._logger.debug("Initialized FileSystemService")
        return self._filesystem_service

    @property
    def extraction_service(self) -> "DateExtractionService":
        if self._extraction_service is None:
            from app.services.extraction_service import DateExtractionService

            self._extraction_service = DateExtractionService()
            self._logger.debug("Initialized DateExtractionService")
        return self._extraction_service

    @property
    def duplicate_service(self) -> "DuplicateService":
        if self._duplicate_service is None:
            from app.services.duplicate_service import DuplicateService

            self._duplicate_service = DuplicateService()
            self._logger.debug("Initialized DuplicateService")
        return self._duplicate_service

    @property
    def metadata_service(self) -> "MetadataService":
        if self._metadata_service is None:
            from app.services.metadata_service import MetadataService

            self._metadata_service = MetadataService()
            self._logger.debug("Initialized MetadataService")
        return self._metadata_service

    @property
    def conversion_service(self) -> "ConversionService":
        if self._conversion_service is None:
            from app.services.conversion_service import ConversionService

            self._conversion_service = ConversionService()
            self._logger.debug("Initialized ConversionService")
        return self._conversion_service

    @property
    def repair_service(self) -> "RepairService":
        if self._repair_service is None:
            from app.services.repair_service import RepairService

            self._repair_service = RepairService()
            self._logger.debug("Initialized RepairService")
        return self._repair_service

    @property
    def sorting_service(self) -> "SortingService":
        if self._sorting_service is None:
            from app.services.sorting_service import SortingService

            self._sorting_service = SortingService(
                config=self._config,
                config_service=self.config_service,
                filesystem_service=self.filesystem_service,
                extraction_service=self.extraction_service,
                duplicate_service=self.duplicate_service,
                metadata_service=self.metadata_service,
                conversion_service=self.conversion_service,
                repair_service=self.repair_service,
                db_manager=self.db_manager,
                rule_engine_service=self.rule_engine_service,
                ai_tagging_service=self.ai_tagging_service,
                category_classifier_service=self.category_classifier_service,
            )
            self._logger.debug("Initialized SortingService")
        return self._sorting_service

    @property
    def task_manager(self) -> "TaskManager":
        if self._task_manager is None:
            from app.background_tasks.task_manager import TaskManager

            self._task_manager = TaskManager()
            self._logger.debug("Initialized TaskManager")
        return self._task_manager

    @property
    def rule_engine_service(self) -> "RuleEngineService":
        if self._rule_engine_service is None:
            from app.services.rule_engine_service import RuleEngineService

            self._rule_engine_service = RuleEngineService(config=self._config)
            self._logger.debug("Initialized RuleEngineService")
        return self._rule_engine_service

    @property
    def hardware_profile(self) -> "HardwareProfile":
        if self._hardware_profile is None:
            from app.services.ai.hardware import HardwareProfile

            self._hardware_profile = HardwareProfile.probe()
            self._logger.debug("Initialized HardwareProfile")
        return self._hardware_profile

    @property
    def encoder(self) -> "VisionEncoder | None":
        """Return the shared local vision encoder, built once via the factory.

        Returns ``None`` when the hardware tier is "off" or the model is
        unavailable (fastembed not installed / download failed).  Both
        AITaggingService and CategoryClassifierService accept ``None`` gracefully.
        """
        if not self._encoder_built:
            from app.services.ai.encoder_factory import build_encoder

            self._encoder = build_encoder(self._config, self.hardware_profile)
            self._encoder_built = True
            self._logger.debug("Initialized vision encoder", encoder=self._encoder)
        return self._encoder

    @property
    def ai_tagging_service(self) -> "AITaggingService":
        if self._ai_tagging_service is None:
            from app.services.ai.ai_tagging_service import AITaggingService

            self._ai_tagging_service = AITaggingService(config=self._config, embedder=self.encoder)
            self._logger.debug("Initialized AITaggingService")
        return self._ai_tagging_service

    @property
    def category_classifier_service(self) -> "CategoryClassifierService":
        if self._category_classifier_service is None:
            from app.services.ai.category_classifier_service import CategoryClassifierService

            self._category_classifier_service = CategoryClassifierService(
                config=self._config, embedder=self.encoder
            )
            self._logger.debug("Initialized CategoryClassifierService")
        return self._category_classifier_service

    @property
    def preview_service(self) -> "PreviewService":
        if self._preview_service is None:
            from app.services.preview_service import PreviewService

            self._preview_service = PreviewService(
                filesystem_service=self.filesystem_service,
                extraction_service=self.extraction_service,
                rule_engine_service=self.rule_engine_service,
                duplicate_service=self.duplicate_service,
                category_classifier_service=self.category_classifier_service,
            )
            self._logger.debug("Initialized PreviewService")
        return self._preview_service

    @property
    def report_service(self) -> "ReportService":
        if self._report_service is None:
            from app.services.report_service import ReportService

            self._report_service = ReportService(db_manager=self.db_manager)
            self._logger.debug("Initialized ReportService")
        return self._report_service

    @property
    def category_suggestion_service(self) -> "CategorySuggestionService":
        if self._category_suggestion_service is None:
            from app.services.ai.category_suggestion_service import CategorySuggestionService

            self._category_suggestion_service = CategorySuggestionService(
                config=self._config, encoder=self.encoder
            )
            self._logger.debug("Initialized CategorySuggestionService")
        return self._category_suggestion_service

    @property
    def analysis_service(self) -> "AnalysisService":
        if self._analysis_service is None:
            from app.services.analysis_service import AnalysisService

            self._analysis_service = AnalysisService(
                filesystem_service=self.filesystem_service,
            )
            self._logger.debug("Initialized AnalysisService")
        return self._analysis_service

    @property
    def update_service(self) -> "UpdateService":
        if self._update_service is None:
            from app.services.update_service import UpdateService

            self._update_service = UpdateService(
                enabled=self._config.update_check_enabled,
            )
            self._logger.debug("Initialized UpdateService")
        return self._update_service


def _make_lifespan(
    logger: BoundLogger,
) -> Callable[[FastAPI], "AbstractAsyncContextManager[None]"]:
    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
        # Capture the running loop so log entries emitted from worker threads
        # (asyncio.to_thread) can be dispatched onto it safely.
        capture_main_loop()
        logger.info("MediaSorter API starting up")
        try:
            yield
        finally:
            logger.info("MediaSorter API shutting down")
            container = app.state.container
            # Only tear down the task manager if one was actually started — the
            # property is lazy, so touching it here would otherwise create a
            # brand-new manager just to shut it down. Shutdown must never raise,
            # or uvicorn reports an error on an otherwise clean exit.
            if container._task_manager is not None:
                try:
                    container._task_manager.shutdown()
                except Exception:  # pragma: no cover - shutdown is best-effort
                    logger.warning("Error during task manager shutdown", exc_info=True)

    return lifespan


class AppFactory:
    """FastAPI application factory."""

    @staticmethod
    def create(config: Config | None = None) -> FastAPI:
        if config is None:
            loader = ConfigLoader()
            config = loader.load()

        import os

        setup_logging(os.getenv("MEDIASORT_LOG_LEVEL", "INFO"))
        from app.services.filesystem_service import register_heif

        register_heif()  # so any direct PIL.Image.open(".heic") in this process works
        logger = get_logger(__name__)
        container = ServiceContainer(config)

        app = FastAPI(
            title="MediaSorter API",
            description="Intelligent media organization backend",
            version=__version__,
            docs_url="/api/docs",
            openapi_url="/api/openapi.json",
            lifespan=_make_lifespan(logger),
        )

        app.state.container = container
        app.state.config = config

        # CORS — local only.
        # tauri://localhost  → macOS/Linux packaged builds.
        # https://tauri.localhost → Windows packaged builds (Tauri 1.5+).
        # http://tauri.localhost  → alternative Windows variant.
        # The regex covers any localhost:<port> used by `vite dev`.
        app.add_middleware(
            CORSMiddleware,
            allow_origins=[
                "http://localhost",
                "http://127.0.0.1",
                "tauri://localhost",
                "https://tauri.localhost",
                "http://tauri.localhost",
            ],
            allow_origin_regex=r"http://(localhost|127\.0\.0\.1):\d+",
            allow_credentials=True,
            allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
            allow_headers=["*"],
            max_age=3600,
        )

        @app.exception_handler(MediaSortException)
        async def mediasort_exception_handler(
            request: Request, exc: MediaSortException
        ) -> JSONResponse:
            return JSONResponse(
                status_code=exc.status_code,
                content={"error": exc.message, "code": exc.code, "details": exc.details},
            )

        @app.exception_handler(Exception)
        async def general_exception_handler(request: Request, exc: Exception) -> JSONResponse:
            logger.error("Unhandled exception", exc_info=True)
            return JSONResponse(
                status_code=500,
                content={"error": "Internal server error", "code": "INTERNAL_ERROR"},
            )

        _include_routes(app, logger)
        logger.info("FastAPI application created")
        return app


def _include_routes(app: FastAPI, logger: BoundLogger) -> None:
    from app.api.routes import (
        ai,
        config,
        health,
        logs,
        media,
        reports,
        scan,
        sorting,
        update,
    )

    app.include_router(health.router, prefix="/api", tags=["health"])
    app.include_router(update.router, prefix="/api", tags=["update"])
    app.include_router(config.router, prefix="/api", tags=["config"])
    app.include_router(ai.router, prefix="/api", tags=["ai"])
    app.include_router(scan.router, prefix="/api", tags=["scan"])
    app.include_router(sorting.router, prefix="/api", tags=["sorting"])
    app.include_router(media.router, prefix="/api", tags=["media"])
    app.include_router(logs.router, prefix="/api", tags=["logs"])
    app.include_router(reports.router, prefix="/api", tags=["reports"])
    logger.info("All API routes registered")
