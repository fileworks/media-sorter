# Maintained decisions

Current choices, not a session log. The linked contract owns implementation detail.
When a lasting choice changes, update its row and the affected instructions in the
same change; record the new date/reason. Release observations belong in release
evidence rather than this table. Personal/security setup never belongs in a public
decision record. Missing private notes do not block ordinary work.

| Date | Choice | Reason | Owning documentation |
|---|---|---|---|
| 2026-10-05 | Bound isolated WebView2 smoke cleanup | Retry sharing locks and the known access-denied metrics-file race for up to ten seconds; unrelated or persistent permission errors still fail. Keep all retries inside disposable smoke state. | [release checks](development.md#releasing) |
| 2026-10-05 | Restore initial state before revealing the desktop workflow | Paint the loading window before background initialization; wait for settings, saved-plan recovery and a reattached task's first status; initialize the recovered stage without a Sources flash; report native frontend readiness afterward. Own/reap children, hide Windows consoles and test actual Blob rendering under packaged CSP. | [startup](install.md#startup-and-interface-language), [UI conventions](frontend-conventions.md), [release checks](development.md#releasing) |
| 2026-10-04 | Separate interface locale from operational labels | EN/DE changes UI and device storage without resetting active progress or invalidating reviewed destinations; backend category language still participates in plan validation. | [UI conventions](frontend-conventions.md), [startup and language](install.md#startup-and-interface-language) |
| 2026-10-05 | Platform-specific Windows icon and typography | Enlarge the ICO mark and explicitly attach its shared 256px resource as the taskbar's large icon, avoiding the 16px title-icon fallback; use native Segoe UI and at least 11px metadata on Windows. Preserve macOS artwork and padding. | [icon and typography](design-system.md#geometry-and-typography) |
| 2026-10-05 | Own and stop the complete backend tree | Cooperative authenticated shutdown drains tasks; atomic Windows Job Object containment also covers shell crashes. Startup close prevents late children, and external development servers remain independent. | [process lifecycle](design.md#port-negotiation-and-process-lifecycle), [API contract](kb-api-contract.md#desktop-shutdown) |
| 2026-10-05 | Resolve reviewed destinations on the backend | Browse, Details and open Compare dialogs use the same immutable derived plan as execution, including companion paths and collision reservations. Suggestions become binding only after acceptance. | [review outcomes](preservation-guarantees.md#reading-duplicate-decisions), [placements API](kb-api-contract.md#reviewed-placements) |
| 2026-10-05 | Root-level copies and consistent review actions | New plans mirror the selected file's relative folders beneath root-level `_copies/`; existing frozen paths and output are retained. Browse projects confirmed sets into their actual destinations and rebuilds after decisions. Shared selection actions remove only selected explicit choices, independently of clearing selection. Use clear file-type names, consistent recommendation styling and actual localized preflight blockers. | [review outcomes](preservation-guarantees.md#reading-duplicate-decisions), [UI behavior](design-system.md#workflow-and-component-rules) |
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
