# Clean-machine release smoke checklist

Use this checklist for periodic clean-host confidence testing and after changes
to installers, startup, migration, signing, or operating-system support. A green
tag workflow publishes the GitHub Release automatically through the protected
`github-release` environment; routine releases do not wait for manual host
evidence. Attach completed evidence to the release or a follow-up issue when the
checklist is run.

Record the commit, tag, artifact SHA-256 values, tester, date, OS version,
architecture, package form, and whether the artifact is signed or explicitly
unsigned.

## macOS Apple Silicon and Intel

Complete every item independently on fresh compatible profiles:

- DMG opens with approved branding and unclipped, intentional app/Applications
  placement.
- Drag-copy install succeeds; first launch follows the verified Gatekeeper path
  when signed or the documented unsigned warning path.
- No Python, Node, or system ffmpeg dependency is required.
- Backend health succeeds; launcher recovery smoke reaches the native
  Reveal Log/Quit path and records `mediasort.log`.
- Current config, database, and log paths match
  [state-and-recovery.md](state-and-recovery.md).
- A seeded historical config/database/log set migrates without source deletion;
  a conflicting destination creates a legacy backup; second launch creates no
  duplicate migration.
- Upgrade from the preceding release preserves configuration and history.
- Signed mode: nested/outer `codesign`, hardened runtime, Gatekeeper,
  notarization ticket, and DMG stapling all verify.

## Windows MSI, NSIS, and portable ZIP

Complete every item for each package form in a fresh Windows VM:

- Approved installer branding is present without clipping or scaling defects.
- Install/run/uninstall and upgrade behavior succeeds where applicable.
- Double-click launch opens no console and starts the backend without a system
  Python or ffmpeg.
- Native startup recovery reaches Reveal Log/Quit and records the full log path.
- Current paths, migration conflict backup, repeat-run idempotence, and upgrade
  preservation match the macOS migration checks.
- Signed mode: nested backend/ffmpeg/DLL, Tauri shell, MSI, NSIS, and portable
  payload signatures use SHA-256 and contain a valid trusted timestamp.
- Unsigned mode: the SmartScreen flow is recorded and release metadata says
  unsigned without making verification claims.

Treat a hash mismatch, signing-state mismatch, or clean-host regression as a
release incident. Stop further distribution updates, preserve the evidence, and
use the documented recovery playbook; do not silently replace published assets.
