# Contributing

Discuss changes to preservation guarantees, the mutation manifest or catalog
schema before implementation. Routine documentation corrections can be proposed
directly. Start at [AGENTS.md](AGENTS.md); record lasting decisions in
[docs/decisions.md](docs/decisions.md) alongside the affected contract.

Use a focused branch and a Conventional Commit subject (`feat:`, `fix:`,
`refactor:`, `docs:`, `chore:`). `feat:` and `fix:` make a new release eligible;
the Version Release workflow is dispatched deliberately. Documentation changes
do not move published tags or replace release assets.

## The quality gate

```console
# backend (start in the repository root)
cd backend
uv sync --locked --all-extras --dev
uv run ruff format --check . && uv run ruff check .
uv run mypy
uv run pytest -q

# frontend (return to the repository root first)
cd ../frontend
npm ci
npm run lint      # --max-warnings 0
npm run format:check
npm test
npm run build     # tsc && vite build
```

For code changes, run the applicable frontend/backend gates above. Documentation-only
changes need documentation links/routing and formatting checks. `npm run
lint` runs with `--max-warnings 0` on purpose.

## What tests are expected to prove

Behaviour, not implementation. A test that would still pass with the feature
deleted is not a test. Bugs get a regression test that fails before the fix.

Never commit personal media, credentials, or generated fixtures larger than a
few kilobytes — the scale suites generate their own.
