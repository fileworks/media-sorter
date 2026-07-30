# Security policy

Report vulnerabilities privately through GitHub Security Advisories for
`fileworks/media-sorter`. Please do not open a public issue, and do not attach
personal media.

Security fixes target the latest release.

## What MediaSorter is, in security terms

MediaSorter is a **local desktop application**. The Tauri shell starts a FastAPI
backend bound to `127.0.0.1` on a free port; nothing listens on an external
interface and no media leaves the machine. Local AI models run in-process.

Two things are worth knowing when assessing a report:

- **The backend trusts its local caller.** It is reachable only from the shell
  on loopback. A report that requires another process on the same machine to
  already be running as the same user is a defence-in-depth issue, not a
  boundary break.
- **Media parsers run in-process.** Pillow, ffmpeg, and the metadata extractors
  handle untrusted input. Malformed media that crashes an extractor is a bug we
  want to hear about; the application is not a sandbox for hostile files.

## What is deliberately out of scope

The application never uploads, never phones home except for the optional update
check against `api.github.com`, and stores no credentials beyond the optional
AI-tagging API keys the user enters, which are kept in the local config file.
