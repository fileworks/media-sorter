# Clean-machine release smoke checklist

Use this checklist for periodic clean-host confidence testing and after changes to
installers, startup, migration, signing, or operating-system support. A green tag
workflow publishes the GitHub Release automatically through the protected
`github-release` environment; routine releases do not wait for manual host evidence.
Attach completed evidence to the release or a follow-up issue when the checklist is run.

Record the commit, tag, artifact SHA-256 values, tester, date, OS version, architecture,
package form, and whether the artifact is signed or explicitly unsigned.

## Unpublished installer candidates

Run `gh workflow run release.yml --ref main` to build and smoke-test the exact
current main commit without publishing a release. The workflow repeats the source,
dependency, native, and package gates, including installed Windows MSI/NSIS and
mounted macOS DMG launch checks. Download the packages from that Actions run and
record its source commit and artifact checksums with the results.

Candidate builds require a manual dispatch on current `origin/main`, clean tracked
source, and embedded versions matching the latest release tag. They keep that
version and are identified by their Actions run and source commit; they do not
replace the published version. Other branch dispatches are rejected. Tag builds
still require the exact generator-owned release transaction, and only tag builds
can enter the public-release job. Use Version Release for a reviewed new version.

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
- NSIS current-user and all-users routes put every executable/resource in a
  dedicated MediaSorter subfolder. A shared-root `/D=` override fails with code 2
  before payload writes. MSI shortcut/resource paths also use that subfolder.
  Inspect the preselected directory after changing scope, with a remembered bare
  Programs directory and with a valid custom MediaSorter directory.
- A registered legacy shared-root NSIS installation is refused before the
  maintenance page can launch its uninstaller, including passive mode. An unknown
  install location or nonstandard old uninstall command also requires review.
- Same-version reinstall/MSI repair and next-version upgrade preserve seeded
  user configuration/history. An unrelated neighboring file survives uninstall.
- With current antivirus definitions and protection enabled, extract/scan/launch
  the downloaded ZIP and each installer; record the provider and any blocked
  file/detection. A hosted startup check alone is not antivirus acceptance proof.
- Double-click launch opens no console and starts the backend without a system
  Python or ffmpeg. The loading screen appears before backend readiness; closing
  it stops pending startup. Record first-window and backend-ready times separately.
- Windows taskbar/Explorer icons have readable artwork at 16/32/48px. Image
  thumbnails, full-screen previews and comparisons render; video uses the
  authenticated Blob path or reports an honest codec fallback. Compare opens from
  collapsed Browse sets in both list and grid. Companion badges remain readable
  at normal and scaled DPI. EN/DE preserves active progress and reviewed decisions.
- Native startup recovery reaches Reveal Log/Quit and records the full log path.
- Current paths, migration conflict backup, repeat-run idempotence, and upgrade
  preservation match the macOS migration checks.
- Signed mode: nested backend/ffmpeg/DLL, Tauri shell, MSI, NSIS, and portable
  payload signatures use SHA-256 and contain a valid trusted timestamp.
- Unsigned mode: the SmartScreen flow is recorded and release metadata says
  unsigned without making verification claims.
- Automatic checks: equal/older stable release gives no banner; a newer release
  appears; disable/re-enable changes network policy immediately; dismissing one
  release does not hide the next. Downloads open the verified release page.

Treat a hash mismatch, signing-state mismatch, or clean-host regression as a release
incident. Stop further distribution updates, preserve the evidence, and use the
documented recovery playbook; do not silently replace published assets.
