#!/usr/bin/env python3
"""MediaSorter CLI — interact with the MediaSorter backend from the terminal."""

from __future__ import annotations

import sys
import time
from pathlib import Path
from typing import Optional

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
    updates: dict = {}
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
    try:
        result = client.scan_source()
        total = result.get("total", 0)
        click.echo(f"Found {total} media file(s):")
        for f in result.get("files", []):
            click.echo(f"  {f}")
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
    try:
        # Use the background-task flow + polling rather than the synchronous
        # endpoint: a large library easily exceeds the HTTP client's 30 s timeout
        # on the single blocking request, whereas polling never times out.
        task_id = client.start_preview()
        while True:
            data = client.get_preview_progress(task_id)
            status = data["status"]
            if status == "completed":
                click.echo(format_preview(data.get("result") or {}))
                break
            if status in ("failed", "cancelled"):
                msg = data.get("error") or f"preview {status}"
                click.echo(f"Error: {msg}", err=True)
                sys.exit(1)
            time.sleep(0.5)
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
