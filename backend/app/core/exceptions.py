"""Custom exception hierarchy for MediaSorter."""

from typing import Any


class MediaSortException(Exception):
    """Base exception for all MediaSorter errors."""

    def __init__(
        self,
        message: str,
        code: str,
        status_code: int = 400,
        details: dict[str, Any] | None = None,
    ) -> None:
        self.message = message
        self.code = code
        self.status_code = status_code
        self.details = details or {}
        super().__init__(self.message)


class ConfigError(MediaSortException):
    def __init__(self, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(message, "CONFIG_ERROR", 400, details)


class ConfigValidationError(MediaSortException):
    """A ``POST /config`` body carried unknown keys or wrongly-typed values.

    422 (Unprocessable Entity), mirroring FastAPI's own request-validation
    status, with the offending fields in ``details["errors"]``."""

    def __init__(self, errors: list[str]) -> None:
        super().__init__(
            "Invalid configuration update",
            "CONFIG_VALIDATION_ERROR",
            422,
            {"errors": errors},
        )


class SourceUnavailableError(MediaSortException):
    def __init__(
        self,
        message: str,
        *,
        path: str = "",
        reason: str = "unavailable",
    ) -> None:
        super().__init__(
            message,
            "SOURCE_UNAVAILABLE",
            422,
            {"path": path, "reason": reason},
        )


class PathOverlapError(MediaSortException):
    def __init__(self, source: str, target: str, relationship: str) -> None:
        super().__init__(
            "Source and destination folders must be different and separate; "
            "neither may contain the other.",
            "PATH_OVERLAP",
            422,
            {"source": source, "target": target, "relationship": relationship},
        )


class SortingError(MediaSortException):
    def __init__(self, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(message, "SORTING_ERROR", 500, details)


class InsufficientStorageError(MediaSortException):
    def __init__(self, message: str, available: int = 0, required: int = 0) -> None:
        super().__init__(
            message,
            "INSUFFICIENT_STORAGE",
            507,
            {"available_bytes": available, "required_bytes": required},
        )


class CorruptedFileError(MediaSortException):
    def __init__(self, message: str, file_path: str = "") -> None:
        super().__init__(message, "CORRUPTED_FILE", 422, {"file_path": file_path})


class MediaFileNotFoundError(MediaSortException):
    """Renamed from FileNotFoundError to avoid shadowing the Python built-in."""

    def __init__(self, message: str, file_path: str = "") -> None:
        super().__init__(message, "FILE_NOT_FOUND", 404, {"file_path": file_path})


class MediaPermissionError(MediaSortException):
    """Renamed from PermissionError to avoid shadowing the Python built-in."""

    def __init__(self, message: str, file_path: str = "") -> None:
        super().__init__(message, "PERMISSION_DENIED", 403, {"file_path": file_path})


class DuplicateDetectionError(MediaSortException):
    def __init__(self, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(message, "DUPLICATE_ERROR", 500, details)


class TaskNotFoundError(MediaSortException):
    def __init__(self, task_id: str) -> None:
        super().__init__(f"Task {task_id!r} not found", "TASK_NOT_FOUND", 404, {"task_id": task_id})


class PreviewError(MediaSortException):
    def __init__(self, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(message, "PREVIEW_ERROR", 500, details)


class OperationNotFoundError(MediaSortException):
    def __init__(self, operation_id: str) -> None:
        super().__init__(
            f"Operation not found: {operation_id!r}",
            "OPERATION_NOT_FOUND",
            404,
            {"operation_id": operation_id},
        )


class ConflictError(MediaSortException):
    def __init__(self, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(message, "CONFLICT", 409, details)


class UnsupportedMediaError(MediaSortException):
    """A media operation was requested on a file the backend cannot handle
    (e.g. a thumbnail/diff for a video or an unreadable image). Maps to 415 so
    the client can fall back to a placeholder instead of treating it as an
    error, while keeping the standard ``{error, code, details}`` envelope."""

    def __init__(self, message: str, file_path: str = "") -> None:
        super().__init__(message, "UNSUPPORTED_MEDIA", 415, {"file_path": file_path})
