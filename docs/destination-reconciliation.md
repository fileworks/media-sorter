# Destination reconciliation

**Backend only.** The Review rework removed the surface that drove this, and no
CLI command replaced it, so `/api/destination-reconciliation` is currently
reachable only by calling it directly. The behaviour below is what those routes
still do; nothing in the shipped interface invokes them.

Reconciliation compares configured inputs directionally against the organized
destination. It does not merge two libraries and never treats destination-only
content as unwanted.

Each media unit receives one classification:

- **matched** — byte identity is confirmed and the complete unit is in the path
  implied by the current configuration;
- **misplaced** — identity exists, but the unit is incomplete or its current path
  differs from today’s date/rename/category configuration;
- **missing** — no destination counterpart was found;
- **extra** — destination content has no counterpart in the connected inputs;
- **unknown** — coverage is unavailable or insufficient to make a claim.

Identity is **confirmed** only by matching SHA-256 content. A re-encoded image may
be **probable** only when a bounded perceptual distance and capture date/camera
metadata both agree. Probable evidence always shows both paths, distance, and
metadata agreement, and requires per-finding confirmation. It is never promoted
to confirmed.

Coverage is shown beside the result. A disconnected input makes its units unknown,
not missing. Extra findings have no checkbox and cannot be converted to deletion
or relocation by the backend.

Selected safe findings become the ordinary immutable copy manifest. The planner
rechecks source and destination fingerprints and rejects drift. Execution remains
the same standard impact-summary, action-journal, and verified-transfer workflow;
reconciliation does not introduce another mutation mechanism.
