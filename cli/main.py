#!/usr/bin/env python3
"""MediaSorter CLI — interact with the MediaSorter backend from the terminal."""

from __future__ import annotations

import sys
import time
from pathlib import Path
from typing import Any, Optional

import click

from cli.utils.api_client import APIClient
from cli.utils.formatters import (
    format_config,
    format_health,
    format_preview,
    format_progress,
    format_report,
)


# ------------------------------------------------------------------ #
# Root group                                                             #
# ------------------------------------------------------------------ #


@click.group()
@click.option(
    "--api-url",
    default="http://localhost:8000",
    envvar="MEDIASORT_API_URL",
    show_default=True,
    help="MediaSorter API base URL.",
)
@click.option("--verbose", "-v", is_flag=True, help="Enable verbose output.")
@click.pass_context
def cli(ctx: click.Context, api_url: str, verbose: bool) -> None:
    """MediaSorter CLI — organise your media files intelligently."""
    ctx.ensure_object(dict)
    ctx.obj["client"] = APIClient(api_url)
    ctx.obj["verbose"] = verbose


# ------------------------------------------------------------------ #
# health                                                                 #
# ------------------------------------------------------------------ #


@cli.command()
@click.pass_context
def health(ctx: click.Context) -> None:
    """Check whether the backend is reachable and healthy."""
    client: APIClient = ctx.obj["client"]
    try:
        data = client.get_health()
        click.echo(format_health(data))
    except Exception as exc:
        click.echo(f"✗ Backend unreachable: {exc}", err=True)
        sys.exit(1)


# ------------------------------------------------------------------ #
# config group                                                           #
# ------------------------------------------------------------------ #


@cli.group()
def config() -> None:
    """Manage MediaSorter configuration."""


@config.command("show")
@click.pass_context
def config_show(ctx: click.Context) -> None:
    """Print current configuration."""
    client: APIClient = ctx.obj["client"]
    try:
        data = client.get_config()
        click.echo(format_config(data))
    except Exception as exc:
        click.echo(f"Error: {exc}", err=True)
        sys.exit(1)


@config.command("set")
@click.option(
    "--source", "source_directory", default=None, help="Source directory path."
)
@click.option(
    "--target", "target_directory", default=None, help="Target directory path."
)
@click.option(
    "--copy/--move", "copy_instead_of_move", default=None, help="Copy or move files."
)
@click.option(
    "--criteria",
    "sort_criteria",
    default=None,
    help="Sort criteria (comma-separated: year,month,day).",
)
@click.pass_context
def config_set(
    ctx: click.Context,
    source_directory: Optional[str],
    target_directory: Optional[str],
    copy_instead_of_move: Optional[bool],
    sort_criteria: Optional[str],
) -> None:
    """Update one or more configuration values."""
    client: APIClient = ctx.obj["client"]
    updates: dict[str, Any] = {}
    if source_directory is not None:
        updates["source_directory"] = source_directory
    if target_directory is not None:
        updates["target_directory"] = target_directory
    if copy_instead_of_move is not None:
        updates["copy_instead_of_move"] = copy_instead_of_move
    if sort_criteria is not None:
        updates["sort_criteria"] = [c.strip() for c in sort_criteria.split(",")]

    if not updates:
        click.echo("Nothing to update. Use --help to see available options.", err=True)
        sys.exit(1)

    try:
        new_cfg = client.update_config(updates)
        click.echo("✓ Configuration updated:")
        click.echo(format_config(new_cfg))
    except Exception as exc:
        click.echo(f"Error: {exc}", err=True)
        sys.exit(1)


@config.command("validate")
@click.pass_context
def config_validate(ctx: click.Context) -> None:
    """Validate the current configuration."""
    client: APIClient = ctx.obj["client"]
    try:
        result = client.validate_config()
        if result["valid"]:
            click.echo("✓ Configuration is valid.")
        else:
            click.echo("✗ Configuration has errors:")
            for err in result.get("errors", []):
                click.echo(f"  - {err}")
            sys.exit(1)
    except Exception as exc:
        click.echo(f"Error: {exc}", err=True)
        sys.exit(1)


# ------------------------------------------------------------------ #
# scan command                                                           #
# ------------------------------------------------------------------ #


@cli.command()
@click.pass_context
def scan(ctx: click.Context) -> None:
    """List media files found in the configured source directory."""
    client: APIClient = ctx.obj["client"]
    task_id: str | None = None
    try:
        task_id = client.start_scan()
        envelope = _poll_operation(client, "scan", task_id)
        result = envelope.get("result") or {}
        total = result.get("total", 0)
        click.echo(f"Found {total} media file(s):")
        if total == 0:
            click.echo("No supported files matched the current scan settings.")
        for f in result.get("files", []):
            click.echo(f"  {f}")
        _show_partial(envelope)
    except KeyboardInterrupt:
        if task_id:
            client.cancel_scan(task_id)
        click.echo("\nCancellation requested.")
    except Exception as exc:
        click.echo(f"Error: {exc}", err=True)
        sys.exit(1)


# ------------------------------------------------------------------ #
# analyze command                                                        #
# ------------------------------------------------------------------ #


@cli.command()
@click.pass_context
def analyze(ctx: click.Context) -> None:
    """Analyze the source through the shared background task transport."""
    client: APIClient = ctx.obj["client"]
    task_id: str | None = None
    try:
        task_id = client.start_analysis()
        envelope = _poll_operation(client, "analysis", task_id)
        result = envelope.get("result") or {}
        click.echo(f"Files: {result.get('total_files', 0)}")
        if result.get("total_files", 0) == 0:
            click.echo("No supported files matched the current analysis settings.")
        click.echo(f"Bytes: {result.get('total_size_bytes', 0)}")
        click.echo(f"Excluded: {result.get('excluded_files', 0)}")
        for warning in result.get("warnings", []):
            click.echo(f"Warning: {warning}")
        _show_partial(envelope)
    except KeyboardInterrupt:
        if task_id:
            client.cancel_analysis(task_id)
        click.echo("\nCancellation requested.")
    except Exception as exc:
        click.echo(f"Error: {exc}", err=True)
        sys.exit(1)


# ------------------------------------------------------------------ #
# preview command                                                        #
# ------------------------------------------------------------------ #


@cli.command()
@click.pass_context
def preview(ctx: click.Context) -> None:
    """Show a dry-run preview of what the sort would do."""
    client: APIClient = ctx.obj["client"]
    task_id: str | None = None
    try:
        task_id = client.start_preview()
        envelope = _poll_operation(client, "preview", task_id)
        click.echo(format_preview(envelope.get("result") or {}))
        _show_partial(envelope)
    except KeyboardInterrupt:
        if task_id:
            client.cancel_preview(task_id)
        click.echo("\nCancellation requested.")
    except Exception as exc:
        click.echo(f"Error: {exc}", err=True)
        sys.exit(1)


# ------------------------------------------------------------------ #
# sort group                                                             #
# ------------------------------------------------------------------ #


@cli.group()
def sort() -> None:
    """Start, monitor, and report on sort operations."""


@sort.command("start")
@click.option("--dry-run", is_flag=True, help="Simulate the sort without moving files.")
@click.option(
    "--watch", "-w", is_flag=True, help="Watch progress until the sort completes."
)
@click.pass_context
def sort_start(ctx: click.Context, dry_run: bool, watch: bool) -> None:
    """Start a sorting operation."""
    client: APIClient = ctx.obj["client"]
    try:
        task_id = client.start_sorting(dry_run=dry_run)
        mode = "dry-run" if dry_run else "live"
        click.echo(f"✓ Sort started ({mode}): {task_id}")

        if watch:
            _watch_task(client, task_id)
        else:
            click.echo(f"  Monitor progress: mediasort sort status {task_id}")
    except Exception as exc:
        click.echo(f"Error: {exc}", err=True)
        sys.exit(1)


@sort.command("status")
@click.argument("task_id")
@click.option("--watch", "-w", is_flag=True, help="Keep refreshing until done.")
@click.pass_context
def sort_status(ctx: click.Context, task_id: str, watch: bool) -> None:
    """Get the status/progress of a sort task."""
    client: APIClient = ctx.obj["client"]
    try:
        if watch:
            _watch_task(client, task_id)
        else:
            data = client.get_sorting_progress(task_id)
            click.echo(format_progress(data))
    except Exception as exc:
        click.echo(f"Error: {exc}", err=True)
        sys.exit(1)


@sort.command("cancel")
@click.argument("task_id")
@click.pass_context
def sort_cancel(ctx: click.Context, task_id: str) -> None:
    """Cancel a running sort task."""
    client: APIClient = ctx.obj["client"]
    try:
        status = client.cancel_sorting(task_id).get("status")
        if status == "cancelled":
            click.echo(f"✓ Task {task_id} cancelled.")
        else:
            # The task had already finished — cancellation was a no-op; don't
            # claim we cancelled a sort that actually completed/failed.
            click.echo(f"Task {task_id} was already {status}; nothing to cancel.")
    except Exception as exc:
        click.echo(f"Error: {exc}", err=True)
        sys.exit(1)


@sort.command("report")
@click.argument("task_id")
@click.pass_context
def sort_report(ctx: click.Context, task_id: str) -> None:
    """Print the sort report for a completed task."""
    client: APIClient = ctx.obj["client"]
    try:
        data = client.get_sorting_report(task_id)
        click.echo(format_report(data))
    except Exception as exc:
        click.echo(f"Error: {exc}", err=True)
        sys.exit(1)


# ------------------------------------------------------------------ #
# report group                                                           #
# ------------------------------------------------------------------ #


@cli.group()
def report() -> None:
    """Export operation reports."""


@report.command("export")
@click.argument("operation_id")
@click.option(
    "--format",
    "fmt",
    type=click.Choice(["json", "csv"]),
    default="json",
    show_default=True,
)
@click.option(
    "--output", "-o", default=None, help="Output file path (default: stdout)."
)
@click.pass_context
def report_export(
    ctx: click.Context, operation_id: str, fmt: str, output: Optional[str]
) -> None:
    """Export a historical operation report as JSON or CSV."""
    client: APIClient = ctx.obj["client"]
    try:
        content = client.export_report(operation_id, fmt)
        if output:
            Path(output).write_bytes(content)
            click.echo(f"✓ Report saved to {output}")
        else:
            click.echo(content.decode())
    except Exception as exc:
        click.echo(f"Error: {exc}", err=True)
        sys.exit(1)


# ------------------------------------------------------------------ #
# Private helpers                                                        #
# ------------------------------------------------------------------ #


def _poll_operation(
    client: APIClient,
    kind: str,
    task_id: str,
    *,
    interval: float = 0.5,
) -> dict[str, Any]:
    """Poll a task without restarting it; return its terminal envelope."""
    getter = {
        "scan": client.get_scan_progress,
        "analysis": client.get_analysis_progress,
        "preview": client.get_preview_progress,
        "sort": client.get_sorting_progress,
    }[kind]
    last_sequence = 0
    last_phase: str | None = None
    while True:
        data = getter(task_id, after_sequence=last_sequence)
        last_sequence = max(last_sequence, int(data.get("last_event_sequence", 0)))
        progress = data.get("progress") or {}
        phase = progress.get("phase")
        if phase and phase != last_phase:
            click.echo(f"{str(phase).replace('_', ' ').capitalize()}…")
            last_phase = str(phase)
        status = data.get("status")
        if status == "completed":
            return data
        if status == "failed":
            failure = data.get("failure") or {}
            message = failure.get("message") or data.get("error") or f"{kind} failed"
            code = failure.get("code")
            raise RuntimeError(f"{message} [{code}]" if code else str(message))
        if status == "cancelled":
            raise RuntimeError(f"{kind.capitalize()} was cancelled.")
        time.sleep(interval)


def _show_partial(envelope: dict[str, Any]) -> None:
    """Surface partial traversal results without dumping every path by default."""
    if not envelope.get("partial"):
        return
    issues = envelope.get("issues") or []
    click.echo(
        f"Warning: result is partial ({len(issues)} inaccessible path(s)).", err=True
    )


def _watch_task(client: APIClient, task_id: str) -> None:
    """Poll the task and print live progress until it finishes."""
    try:
        while True:
            data = client.get_sorting_progress(task_id)
            click.clear()
            click.echo("MediaSorter — Live Sort Progress")
            click.echo(format_progress(data))

            if data["status"] not in ("pending", "running"):
                click.echo("")
                if data["status"] == "completed":
                    click.echo("✓ Sort completed successfully.")
                    report_data = client.get_sorting_report(task_id)
                    click.echo(format_report(report_data))
                elif data["status"] == "failed":
                    click.echo(
                        f"✗ Sort failed: {data.get('error', 'unknown error')}", err=True
                    )
                    sys.exit(1)
                else:
                    click.echo(f"Task ended with status: {data['status']}")
                break

            time.sleep(1)
    except KeyboardInterrupt:
        click.echo("\nInterrupted. Sort continues in the background.")
        click.echo(f"  Check status: mediasort sort status {task_id}")


if __name__ == "__main__":
    cli()
