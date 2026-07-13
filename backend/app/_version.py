"""Single source of truth for the backend version.

`scripts/sync-version.mjs` rewrites the literal below on every release (driven by
semantic-release from Conventional Commits). `pyproject.toml` reads it through
hatchling's dynamic-version hook, and both the FastAPI app (`bootstrap.py`) and
`/api/health` import `__version__` from here — so the running backend always
reports the released version instead of a stale hardcoded one.
"""

__version__ = "1.0.3"
