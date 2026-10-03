# MediaSorter agent instructions

This is a public repository; source and desktop installers are public.
AGENTS.md is the shared authority; CLAUDE.md only imports this file.

Preserve source bytes, companion units, immutable references and reviewed plans.
Use the service container/Depends, typed schemas and DatabaseManager boundaries.
Keep blocking work off the event loop; use the standard error envelope and Config.
Database migrations must remain additive, backed up, transactional and idempotent.
Frontend server state belongs in TanStack Query hooks; use semantic UI tokens.
Test mutations with disposable media and real temporary databases.

## Read only what the task needs

Read only the matching route. Cross-repo choices may use
`../agent-context/context/ROUTER.md`; owner/security operations may use
`../_local/AGENT-ROUTER.md` when present. Both are optional: standalone
work needs neither. Never import private context.

| Working on | First read |
|---|---|
| Installation or packaging | [install guide](docs/install.md), [development](docs/development.md#releasing) |
| Files, duplicates, transfer or recovery | [preservation contract](docs/preservation-guarantees.md), then the relevant entry in [docs map](docs/README.md) |
| Backend, routes or migrations | [backend rules](docs/kb-backend.md); HTTP changes also [API contract](docs/kb-api-contract.md) |
| Frontend | [UI conventions](docs/frontend-conventions.md), [design system](docs/design-system.md) |
| Local AI or models | [model distribution](docs/model-distribution.md), [evaluation](docs/local-ai-evaluation.md) |
| Tests or development setup | [development](docs/development.md), [test rules](docs/kb-testing.md) |
| Architecture or ownership | [design](docs/design.md), [ownership](docs/architecture-ownership.md), [decisions](docs/decisions.md) |

## Before finishing

- Update affected docs/routes with behavior. For changed lasting decisions, update
  [docs/decisions.md](docs/decisions.md) with date, reason and owning contract;
  replace superseded guidance. Keep one TODO per concern, not session logs.
- Run relevant checks and show output/skips. Doc-only edits need routing/link
  checks, not a product release. Keep credentials/personal operations out of commits.
- Preserve concurrent work. Use the configured owner identity, no AI co-authors.
  Keep the README AI-first disclosure. Remote writes/publication need authorization.
