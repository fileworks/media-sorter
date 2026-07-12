"""Response schemas shared across more than one route module.

Per-route response models live in their own route file; this module holds only
the ones used by several files so the two can never drift (Hard Rules 1 & 3).
"""

from typing import Any

from pydantic import BaseModel


class TaskProgressResponse(BaseModel):
    """Status payload for a background task (sort or preview), returned by the
    polling endpoints. ``result`` is the task's terminal payload (a sort report
    or a preview) and stays an open mapping because its shape depends on the
    task type; ``progress`` mirrors the live ``TaskProgress`` fields."""

    task_id: str
    status: str
    progress: dict[str, Any]
    error: str | None = None
    result: dict[str, Any] | None = None
