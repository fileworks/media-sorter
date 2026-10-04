# Maintained decisions

Current choices, not a session log. The linked contract owns implementation detail.
When a lasting choice changes, update its row and the affected instructions in the
same change; record the new date/reason. Release observations belong in release
evidence rather than this table. Personal/security setup never belongs in a public
decision record. Missing private notes do not block ordinary work.

| Date | Choice | Reason | Owning documentation |
|---|---|---|---|
| 2026-10-04 | Update notifications honor live settings and release identity | Re-enabling invalidates the six-hour frontend cache; dismissals are per version; only stable newer releases and architecture-matching trusted assets are offered. | [automatic checking](install.md#automatic-update-checking) |
| 2026-10-04 | Dedicated Windows app directory and unpacked native backend libraries | Validate the original NSIS `/D=` request before MultiUser defaults can hide it; retain safe silent targets, reject shared-root installs/uninstalls and unsafe legacy maintenance; validate installed layout, repair/reinstall and startup failures; disable ambient UPX without claiming antivirus acceptance. | [installation](install.md#windows-installation-directory), [release checks](release-smoke-checklist.md) |
| 2026-10-03 | Portable agent routes and task-time documentation maintenance | Standalone development stays self-contained; docs/routes change with behavior. | [agent guide](../AGENTS.md) |
| 2026-10-03 | Reviewed runner images and short-lived CI artifacts | Avoid image retirement/migration surprises while keeping required check names and durable releases. | [development](development.md#quality-gates) |
| 2026-10-03 | Authenticated loopback container health checks | Health uses the same API boundary; Compose requires a launch capability and binds loopback. | [headless](headless.md) |
| 2026-10-03 | Native cross-platform development entry points | Windows batch files cannot be spawned directly; use npm's JS CLI and the platform's venv interpreter. | [development](development.md#setup) |
| 2026-10-02 | Public source and installers | A reusable portfolio tool; install without an account. | [install](install.md) |
| 2026-10-02 | Reviewed, byte-preserving operations | Organizing must preserve originals and companions; private workflows do not change this contract. | [preservation](preservation-guarantees.md) |
| 2026-10-02 | Local optional AI | Media remains on-device; model packs are opt-in and checksum-pinned. | [models](model-distribution.md) |
| 2026-10-02 | Unsigned installers | Signing/notarization is future work; checksums do not establish publisher identity. | [signing](release-signing.md) |

All applications were generated AI-first. Commit authorship uses the owner's
configured identity; this does not imply unaided implementation.
