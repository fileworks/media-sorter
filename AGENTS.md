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

Follow the matching route below; do not load the entire documentation set.
If `../_local/AGENT-ROUTER.md` exists and the task involves owner-specific,
security, or cross-repository decisions, follow its relevant route. It is
optional private context: a standalone clone must work without it. Do not ask
for private notes to perform ordinary work. Never import them from CLAUDE.md.

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

- Update the affected user/developer instructions in the same change as behavior.
- For a lasting decision, update [docs/decisions.md](docs/decisions.md): date,
  choice, reason, and a link to the owning contract. Replace superseded choices;
  do not add session transcripts or repeat facts already owned elsewhere.
- Update this routing table when a new maintained topic needs an entry point.
- Keep credentials, personal data, security setup and private operational notes
  out of public commits. If the optional private workspace exists, put those
  decisions there; otherwise report the missing context only when it blocks work.
- Run the checks appropriate to the change; report actual output and skips.
  Documentation-only changes need link/routing checks, not a new product release.
- Use the owner's configured Git identity; no AI authors/co-author trailers.
  Keep the README's AI-first disclosure. Publishing requires task authorization.
