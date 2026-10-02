"""Output formatters for CLI display."""

from __future__ import annotations

from typing import Any, Dict


def format_progress(progress: Dict[str, Any]) -> str:
    """Format a sorting progress dict as a human-readable string."""
    status = progress.get("status", "unknown")
    p = progress.get("progress", {})
    current = p.get("current", 0)
    total = p.get("total", 0)
    pct = p.get("percentage", 0.0)
    eta = p.get("estimated_time_remaining_seconds")
    error = progress.get("error")

    lines = [
        f"Task:     {progress.get('task_id', 'N/A')}",
        f"Status:   {status}",
        f"Progress: {current}/{total} ({pct:.1f}%)",
    ]

    if eta is not None:
        mins, secs = divmod(int(eta), 60)
        lines.append(f"ETA:      {mins}m {secs}s")

    if error:
        lines.append(f"Error:    {error}")

    # Progress bar (40 chars wide)
    bar_width = 40
    filled = int(bar_width * pct / 100) if total else 0
    bar = "█" * filled + "░" * (bar_width - filled)
    lines.append(f"[{bar}]")

    return "\n".join(lines)


def format_report(report: Dict[str, Any]) -> str:
    """Format a sort result dict as a human-readable summary."""
    if not report:
        return "No report available."

    lines = [
        "=" * 50,
        "  MediaSorter — Sort Report",
        "=" * 50,
        f"  Total files:    {report.get('total', 0)}",
        f"  Sorted:         {report.get('sorted', 0)}",
        f"  Duplicates:     {report.get('duplicates', 0)}",
        f"  Future dates:   {report.get('future_dates', 0)}",
        f"  Unknown dates:  {report.get('unknown_dates', 0)}",
        f"  Corrupted:      {report.get('corrupted', 0)}",
        f"  Failed:         {report.get('failed', 0)}",
        "=" * 50,
    ]

    op_id = report.get("operation_id")
    if op_id:
        lines.append(f"  Operation ID: {op_id}")

    return "\n".join(lines)


def format_preview(preview: Dict[str, Any]) -> str:
    """Format a preview result dict as a human-readable summary."""
    stats = preview.get("stats", {})
    items = preview.get("items", [])

    lines = [
        "=" * 50,
        "  MediaSorter — Dry-Run Preview",
        "=" * 50,
        f"  Total files:   {stats.get('total', 0)}",
        f"  Will sort:     {stats.get('will_sort', 0)}",
        f"  Will fail:     {stats.get('will_fail', 0)}",
        "=" * 50,
    ]

    if items:
        lines.append("")
        lines.append("  File destinations:")
        for item in items[:20]:  # show first 20
            src = item.get("source", "?")
            dst = item.get("destination", "?")
            date_str = item.get("extracted_date", "unknown")
            tags = item.get("tags", [])
            tag_str = f"  [{', '.join(tags)}]" if tags else ""
            lines.append(f"    {src}")
            lines.append(f"    → {dst}  ({date_str}){tag_str}")
        if len(items) > 20:
            lines.append(f"    ... and {len(items) - 20} more")

    return "\n".join(lines)


def format_config(config: Dict[str, Any]) -> str:
    """Format a config dict as a human-readable table."""
    lines = [
        "=" * 50,
        "  MediaSorter — Configuration",
        "=" * 50,
    ]
    for key, value in config.items():
        if key.startswith("_"):
            continue
        lines.append(f"  {key:<30} {value}")
    lines.append("=" * 50)
    return "\n".join(lines)


def format_health(health: Dict[str, Any]) -> str:
    """Format a health check response."""
    status = health.get("status", "unknown")
    version = health.get("version", "?")
    icon = "✓" if status == "ok" else "✗"
    return f"{icon} Backend status: {status}  (version {version})"
