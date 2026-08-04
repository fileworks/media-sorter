# Documentation map

Two audiences. `kb-*.md` are rules to follow while writing code — terse, one rule
per line, no prose. Everything else explains a subsystem to a person.

## Rules to follow while implementing

| File | Read when |
|---|---|
| [kb-backend.md](kb-backend.md) | writing a route, service, schema, or migration |
| [kb-api-contract.md](kb-api-contract.md) | changing an HTTP shape, status code, or error |
| [kb-testing.md](kb-testing.md) | writing a backend test |
| [kb-deprecated.md](kb-deprecated.md) | before adopting a pattern — rules out the anti-patterns first |

## What the product promises

| File | Covers |
|---|---|
| [preservation-guarantees.md](preservation-guarantees.md) | the user-facing promise, its exact limits, and what to do when something goes wrong |
| [settings-reference.md](settings-reference.md) | every configuration field, its default, and what it does |
| [duplicate-review.md](duplicate-review.md) | duplicate groups, keeper policies, reference protection, quarantine |
| [burst-review.md](burst-review.md) | burst detection, its three signals, and the calibration behind the defaults |
| [content-identity.md](content-identity.md) | cache hints vs. cryptographic proof, and why they are never the same thing |

## How it is built

| File | Covers |
|---|---|
| [design.md](design.md) | architecture and the *why* behind each decision |
| [development.md](development.md) | setup, running, quality gates, testing, releasing |
| [architecture-ownership.md](architecture-ownership.md) | the module seams and the growth-review policy |

## Integrity, state, and recovery

| File | Covers |
|---|---|
| [integrity-baseline.md](integrity-baseline.md) | the mutation ledger, transfer diagnostics, remaining gaps |
| [state-and-recovery.md](state-and-recovery.md) | state paths, migration, interrupted-operation reconciliation |
| [catalog-and-resume.md](catalog-and-resume.md) | the persistent index and what a second run may reuse |
| [filesystem-capability-matrix.md](filesystem-capability-matrix.md) | what is probed on the destination filesystem, and why a platform label is not proof |
| [observability.md](observability.md) | event vocabulary, correlation, redaction rules |

## Not reachable from the interface

The Review rework removed the surfaces that drove these. The backends still work
and are still tested; each file says so at the top.

| File | Reached by |
|---|---|
| [library-audit.md](library-audit.md) | `mediasort audit`, `/api/audit` |
| [destination-reconciliation.md](destination-reconciliation.md) | `/api/destination-reconciliation` only |
| [optimization-contracts.md](optimization-contracts.md) | nothing yet — no contract has passed validation, so no optimizer can run |

## Supply chain and release

| File | Covers |
|---|---|
| [dependency-security.md](dependency-security.md) | the dependency audit policy and its suppression file |
| [model-distribution.md](model-distribution.md) | optional CLIP/SigLIP packs, pinned digests, the mirror escape hatch |
| [release-signing.md](release-signing.md) | signing credentials and the declared signed/unsigned state |
| [release-smoke-checklist.md](release-smoke-checklist.md) | the clean-machine confidence pass after a release |
