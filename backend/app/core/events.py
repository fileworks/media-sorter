"""One definition of every operation event, shared by backend, UI, and CLI.

An event code is a contract: its severity, privacy class, and message key are
declared here once, so a surface can render an event it has never seen and a
support bundle can be redacted without knowing what produced it. Codes are
additive — renaming one is a schema change, not an edit.
"""

from __future__ import annotations

import contextlib
import hashlib
import re
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.core.integrity import (
    EVENT_SCHEMA_VERSION,
    OperationEvent,
    PrivacyClass,
    Severity,
)

REDACTED = "[REDACTED]"

#: Substrings that mark a value as credential-like wherever it appears. Kept in
#: sync with the logging processor so no sink can see what the other redacts.
SECRET_MARKERS = (
    "api_key",
    "apikey",
    "authorization",
    "cookie",
    "credential",
    "password",
    "passphrase",
    "secret",
    "token",
)

#: Keys whose values are filesystem locations. They are tokenized rather than
#: dropped so a reader can still tell two events apart and see that they share
#: a root.
PATH_KEYS = ("path", "paths", "directory", "folder", "root", "file", "filename")


class EventContractError(RuntimeError):
    """An event violated the declared contract and must not be emitted."""


@dataclass(frozen=True)
class EventDefinition:
    """What a code means, independent of who renders it."""

    code: str
    severity: Severity
    privacy: PrivacyClass
    message_key: str
    #: Terminal events conclude an operation. Exactly one may be emitted.
    terminal: bool = False


def _definitions() -> dict[str, EventDefinition]:
    declared = (
        # Lifecycle
        EventDefinition("operation.started", "info", "operational", "operation.started"),
        EventDefinition("operation.preflight", "info", "operational", "operation.preflight"),
        EventDefinition("operation.authorized", "info", "operational", "operation.authorized"),
        EventDefinition(
            "operation.authorization_refused",
            "error",
            "operational",
            "operation.authorization_refused",
        ),
        EventDefinition("operation.phase_changed", "debug", "operational", "operation.phase"),
        EventDefinition("operation.checkpoint", "debug", "operational", "operation.checkpoint"),
        # Cancellation
        EventDefinition(
            "operation.cancellation_requested",
            "info",
            "operational",
            "operation.cancellation_requested",
        ),
        EventDefinition(
            "operation.cancellation_observed",
            "info",
            "operational",
            "operation.cancellation_observed",
        ),
        # Per-item work
        EventDefinition("action.authorized", "debug", "path", "action.authorized"),
        EventDefinition("action.outcome", "info", "path", "action.outcome"),
        EventDefinition("action.issue", "warning", "path", "action.issue"),
        EventDefinition("transfer.retry", "warning", "path", "transfer.retry"),
        EventDefinition("transfer.degraded", "warning", "path", "transfer.degraded"),
        EventDefinition("integrity.violation", "critical", "path", "integrity.violation"),
        # Optimization — never ordinary movement, so never an action.* code
        EventDefinition("optimization.blocked", "warning", "operational", "optimization.blocked"),
        EventDefinition("optimization.sampled", "info", "path", "optimization.sampled"),
        EventDefinition("optimization.projected", "info", "operational", "optimization.projected"),
        EventDefinition("optimization.validated", "info", "path", "optimization.validated"),
        EventDefinition("optimization.rejected", "warning", "path", "optimization.rejected"),
        # Quarantine — an original that moved, and the record that brings it back
        EventDefinition("quarantine.recorded", "info", "path", "quarantine.recorded"),
        EventDefinition("quarantine.restored", "info", "path", "quarantine.restored"),
        # Recovery
        EventDefinition("recovery.scanned", "info", "operational", "recovery.scanned"),
        EventDefinition("recovery.reconciled", "info", "path", "recovery.reconciled"),
        EventDefinition("recovery.review_required", "warning", "path", "recovery.review_required"),
        # Diagnostics health
        EventDefinition("logging.degraded", "warning", "operational", "logging.degraded"),
        # Terminal outcomes — exactly one per operation
        EventDefinition("operation.completed", "info", "operational", "operation.completed", True),
        EventDefinition(
            "operation.completed_with_warnings",
            "warning",
            "operational",
            "operation.completed_with_warnings",
            True,
        ),
        EventDefinition("operation.partial", "warning", "operational", "operation.partial", True),
        EventDefinition("operation.cancelled", "info", "operational", "operation.cancelled", True),
        EventDefinition("operation.failed", "error", "operational", "operation.failed", True),
    )
    return {definition.code: definition for definition in declared}


EVENT_REGISTRY: Mapping[str, EventDefinition] = _definitions()

TERMINAL_EVENT_BY_OUTCOME: Mapping[str, str] = {
    "completed": "operation.completed",
    "completed_with_warnings": "operation.completed_with_warnings",
    "partial": "operation.partial",
    "cancelled": "operation.cancelled",
    "failed": "operation.failed",
}


def definition(code: str) -> EventDefinition:
    try:
        return EVENT_REGISTRY[code]
    except KeyError:
        raise EventContractError(f"Unknown event code: {code!r}") from None


class PathTokenizer:
    """Replaces filesystem locations with stable, relationship-preserving tokens.

    Two paths under one root share a root token, so a reader can still see that
    a source and a destination were on the same volume, without learning either
    name. Tokens are stable within one tokenizer and meaningless outside it.
    """

    def __init__(self) -> None:
        self._roots: dict[str, str] = {}

    def token(self, value: Path | str) -> str:
        path = Path(value)
        anchor = str(path.anchor or path.parts[0] if path.parts else "")
        root = self._roots.setdefault(anchor, f"root{len(self._roots) + 1}")
        depth = max(len(path.parts) - 1, 0)
        return f"<{root}>/…{depth}/{_digest(path.name)}" if path.name else f"<{root}>"


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:12]


def _is_secret_key(key: str) -> bool:
    lowered = str(key).lower()
    return any(marker in lowered for marker in SECRET_MARKERS)


def _is_path_key(key: str) -> bool:
    lowered = re.sub(r"[^a-z]", "_", str(key).lower())
    return any(part in lowered.split("_") for part in PATH_KEYS)


def sanitize_context(
    context: Mapping[str, Any],
    *,
    tokenizer: PathTokenizer,
) -> dict[str, Any]:
    """Make one event's context safe for every sink, without dropping meaning.

    Credential-like values are removed outright. Filesystem locations are
    tokenized. Media bytes never reach here: anything that is not a primitive,
    a path, or a container of those is reduced to its type name.
    """
    safe: dict[str, Any] = {}
    for key, value in context.items():
        if _is_secret_key(key):
            safe[str(key)] = REDACTED
        elif _is_path_key(key):
            safe[str(key)] = _tokenize_value(value, tokenizer)
        else:
            safe[str(key)] = _scalarize(value, tokenizer)
    return safe


def _tokenize_value(value: Any, tokenizer: PathTokenizer) -> Any:
    if isinstance(value, (str, Path)):
        return tokenizer.token(value)
    if isinstance(value, (list, tuple)):
        return [_tokenize_value(item, tokenizer) for item in value]
    return _scalarize(value, tokenizer)


def _scalarize(value: Any, tokenizer: PathTokenizer) -> Any:
    if isinstance(value, (bool, int, float)) or value is None:
        return value
    if isinstance(value, str):
        return value
    if isinstance(value, Path):
        return tokenizer.token(value)
    if isinstance(value, bytes):
        return f"<{len(value)} bytes>"
    if isinstance(value, Mapping):
        return {
            str(k): (REDACTED if _is_secret_key(k) else _scalarize(v, tokenizer))
            for k, v in value.items()
        }
    if isinstance(value, (list, tuple, set, frozenset)):
        return [_scalarize(item, tokenizer) for item in value]
    return f"<{type(value).__name__}>"


class EventRecorder:
    """Builds correlated events for one operation and enforces the contract.

    Every event carries the operation, task, plan, and profile identity it
    happened under, so a timeline can be reassembled from any single sink. The
    recorder refuses an unknown code and refuses a second terminal event, which
    is how "exactly one outcome" becomes a runtime property rather than a
    convention.
    """

    def __init__(
        self,
        operation_id: str,
        *,
        task_id: str | None = None,
        plan_id: str | None = None,
        profile_id: str | None = None,
        sink: Any | None = None,
    ) -> None:
        self.operation_id = operation_id
        self.task_id = task_id
        self.plan_id = plan_id
        self.profile_id = profile_id
        self.schema_version = EVENT_SCHEMA_VERSION
        self._sink = sink
        self._tokenizer = PathTokenizer()
        self._events: list[OperationEvent] = []
        self._terminal: OperationEvent | None = None

    @property
    def events(self) -> tuple[OperationEvent, ...]:
        return tuple(self._events)

    @property
    def terminal(self) -> OperationEvent | None:
        return self._terminal

    def emit(
        self,
        code: str,
        *,
        action_id: str | None = None,
        root_id: str | None = None,
        phase: str | None = None,
        **context: Any,
    ) -> OperationEvent:
        declared = definition(code)
        if self._terminal is not None:
            raise EventContractError(
                f"Operation {self.operation_id} already concluded with "
                f"{self._terminal.event_code!r}; cannot emit {code!r}"
            )
        event = OperationEvent(
            sequence=len(self._events) + 1,
            event_code=declared.code,
            severity=declared.severity,
            privacy=declared.privacy,
            operation_id=self.operation_id,
            task_id=self.task_id,
            plan_id=self.plan_id,
            action_id=action_id,
            profile_id=self.profile_id,
            root_id=None if root_id is None else self._tokenizer.token(root_id),
            phase=phase,
            message_key=declared.message_key,
            context=sanitize_context(context, tokenizer=self._tokenizer),
        )
        self._events.append(event)
        if declared.terminal:
            self._terminal = event
        self._publish(event)
        return event

    def conclude(self, outcome: str, **context: Any) -> OperationEvent:
        """Emit the single terminal event for an operation outcome."""
        try:
            code = TERMINAL_EVENT_BY_OUTCOME[outcome]
        except KeyError:
            raise EventContractError(f"Unknown operation outcome: {outcome!r}") from None
        return self.emit(code, **context)

    def _publish(self, event: OperationEvent) -> None:
        if self._sink is None:
            return
        # A sink must never break an operation; a failed publication is a
        # diagnostics problem, not a media problem.
        with contextlib.suppress(Exception):
            self._sink(event)


def structlog_sink(logger: Any) -> Any:
    """Return a sink that writes events through the shared structured logger."""

    def publish(event: OperationEvent) -> None:
        logger.log(
            _LEVEL_BY_SEVERITY[event.severity],
            event.event_code,
            operation_id=event.operation_id,
            task_id=event.task_id,
            action_id=event.action_id,
            profile_id=event.profile_id,
            phase=event.phase,
            sequence=event.sequence,
            privacy=event.privacy,
            **event.context,
        )

    return publish


_LEVEL_BY_SEVERITY: Mapping[Severity, int] = {
    "debug": 10,
    "info": 20,
    "warning": 30,
    "error": 40,
    "critical": 50,
}
