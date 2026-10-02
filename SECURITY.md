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

- **The backend authenticates its local caller.** Loopback binding is not the
  boundary — any process on the machine can reach a loopback port. Every HTTP
  and WebSocket request must present a per-launch capability secret, and any
  request carrying an `Origin` must present one on the exact allowlist:
  - HTTP sends it in `X-MediaSorter-Capability`; a WebSocket, which cannot set
    headers, sends it in the subprotocol. It is compared in constant time, as
  bytes rather than text, and is at least 32 characters.
  - Exactly one exemption exists, and it is narrow: a genuine CORS preflight —
    an `OPTIONS` request carrying **both** an allowed `Origin` and an
    `Access-Control-Request-Method`. Browsers cannot attach the capability
    header to a preflight. Both halves of that test are load-bearing: exempting
    every `OPTIONS` would admit requests with no `Origin` at all, because the
    origin check only runs when an origin is present. The resource request that
    follows a preflight is authenticated normally.
  - A 403 for a disallowed origin deliberately carries no CORS headers, so a
    rejection never advertises the boundary it just enforced.

  A report that requires another process on the same machine to already be
  running as the same user *and* to have obtained the capability is a
  defence-in-depth issue. One that reaches the API **without** the capability
  is a boundary break, and we want to hear about it.
- **Media parsers run in-process.** Pillow, ffmpeg, and the metadata extractors
  handle untrusted input. Malformed media that crashes an extractor is a bug we
  want to hear about; the application is not a sandbox for hostile files.

## What is deliberately out of scope

The application never uploads, never phones home except for the optional update
check against `api.github.com`, and stores no cloud media credentials. AI tagging and
categorization are local-only; model downloads are explicit and checksum-verified.
