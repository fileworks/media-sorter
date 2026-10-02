# Contributing

Open an issue before changing preservation guarantees, the mutation manifest,
the catalog schema, or anything under `docs/` that a user relies on. Those are
contracts, and changing one is a decision rather than a refactor.

Use a focused branch and a Conventional Commit subject (`feat:`, `fix:`,
`refactor:`, `docs:`, `chore:`). `feat:` and `fix:` cut a release; the others
deliberately do not.

## The quality gate

```console
# backend
cd backend && uv sync --all-extras --dev
uv run ruff format --check . && uv run ruff check .
uv run mypy
uv run pytest -q

# frontend
cd frontend && npm ci
npm run lint      # --max-warnings 0
npm test
npm run build     # tsc && vite build
```

All four frontend commands and all four backend commands must pass. `npm run
lint` runs with `--max-warnings 0` on purpose.

## What tests are expected to prove

Behaviour, not implementation. A test that would still pass with the feature
deleted is not a test. Bugs get a regression test that fails before the fix.

Never commit personal media, credentials, or generated fixtures larger than a
few kilobytes — the scale suites generate their own.
