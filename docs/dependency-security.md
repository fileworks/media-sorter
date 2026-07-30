# Dependency security policy

Release CI audits the locked shipped dependency sets: backend plus `local-ai`,
frontend production dependencies, and the Rust desktop lock. Scanner versions
are pinned in generated workflows and printed in job logs.

Suppressions live in `dependency-audit-suppressions.json`. Each entry has an
advisory, ecosystem, exact dependency-set scope, owner, reachability evidence,
creation date, and an expiry no more than 90 days later. CI rejects malformed or
expired entries before invoking the scanner. npm advisories are not suppressible
through this file; a vulnerable production npm lock must be upgraded.

## Rust warning inventory

The following RustSec warnings are not vulnerability suppressions. They are
transitive Tauri 1 desktop-stack maintenance work and remain visible in
`cargo audit` output:

| Family | Current route | Compatibility plan | Owner |
|---|---|---|---|
| GTK3 bindings (`atk`, `gdk`, `gtk` and sys/macros crates) | Tauri 1 Linux webview | Remove through the future Tauri/webview migration; keep Linux build smoke coverage until then | `fileworks/release` |
| `fxhash`, `instant`, `proc-macro-error` | Tauri 1 transitive graph | Prefer parent upgrades; do not add direct pins that mask the parent dependency | `fileworks/release` |
| `anyhow`, `glib`, `rand` unsound warnings | Tauri 1 platform graph | Track patched compatible parent releases and keep the Rust audit visible on every release | `fileworks/release` |

The two quick-xml advisories have temporary, expiring reachability suppressions.
They must be removed as soon as the parent graph permits quick-xml 0.41 or the
desktop shell migrates; expiry deliberately blocks unattended acceptance.
