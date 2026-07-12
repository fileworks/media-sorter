---
name: decisions
description: Key architectural and technical decisions with reasoning. Load when making design choices or understanding why something is built a certain way.
triggers:
  - "why do we"
  - "why is it"
  - "decision"
  - "alternative"
  - "we chose"
edges:
  - target: context/architecture.md
    condition: when a decision relates to system structure
  - target: context/stack.md
    condition: when a decision relates to technology choice
  - target: context/ai.md
    condition: when the decision is about AI model choice, tagging vs categorization, or confidence gating
  - target: patterns/ai-integration.md
    condition: when implementing something that a decision constrains (e.g. temperature, sigmoid scoring)
last_updated: 2026-06-21
---

# Decisions

<!-- When a decision changes: mark the old entry "Superseded by [title]", add the new entry above it. Never delete. -->

## Decision Log

### HTTP IPC between Tauri shell and Python backend
**Date:** 2024-xx-xx
**Status:** Active
**Decision:** The Rust shell communicates with the Python backend over localhost HTTP + WebSocket, not native Tauri IPC.
**Reasoning:** The backend stays independently runnable and testable — you can `curl` it, point pytest at it, or run it headless in Docker without Rust or JavaScript.
**Alternatives considered:** Tauri command IPC (rejected — welds business logic to the Rust/JS boundary and makes Python untestable alone).
**Consequences:** Tiny localhost round-trip (irrelevant for a file-sorting tool). Port negotiation required at startup.

### SQLite over PostgreSQL, raw sqlite3 over ORM
**Date:** 2024-xx-xx
**Status:** Active
**Decision:** All persistent state lives in SQLite accessed through raw `sqlite3` via `DatabaseManager`. No external database server, no ORM.
**Reasoning:** Zero setup for end users, portable across macOS/Windows/Linux, far more than sufficient for single-user desktop scale. Removes SQLAlchemy from the PyInstaller bundle.
**Alternatives considered:** PostgreSQL (rejected — requires a running server, defeats self-contained install goal); SQLAlchemy (rejected — adds bundle weight and session management complexity for simple queries).
**Consequences:** All schema changes are additive `ALTER TABLE … ADD COLUMN` in `init_schema()`; never drop/rename columns.

### ONNX Runtime (fastembed) over PyTorch for AI inference
**Date:** 2024-xx-xx
**Status:** Active
**Decision:** Local AI inference uses ONNX Runtime via fastembed, not PyTorch or transformers.
**Reasoning:** Avoids a ~2 GB PyTorch install in the frozen desktop bundle. ONNX Runtime runs natively on macOS (CoreML) and Windows (DirectML) without CUDA.
**Alternatives considered:** PyTorch + CLIP (rejected — too large for a desktop bundle); transformers (rejected — same issue).
**Consequences:** Must add `--collect-all=<pkg>` to the `bundle-backend` Makefile target for any new native dependency.

### AI tagging and Smart Categorization are separate features
**Date:** 2024-xx-xx
**Status:** Active
**Decision:** "AI content tagging" (writes keywords into files) and "Smart Categorization" (decides folder placement) are independently configured and coded, though they share one CLIP encoder instance.
**Reasoning:** The two features are orthogonal: tagging is descriptive metadata, categorization is a placement decision. Users may want one without the other. Independent config prevents accidental coupling.
**Alternatives considered:** Single AI feature that does both (rejected — conflates metadata and routing, makes independent enable/disable impossible).
**Consequences:** Categorization runs in preview (placement affects dry-run output); AI tagging does not (to avoid burning quota/CPU on dry runs). Both share `container.encoder` — the encoder is built once.

### Multi-label sigmoid (not softmax) for AI tagging
**Date:** 2025-xx-xx
**Status:** Active
**Decision:** Local CLIP tagging uses `sigmoid(slope · (cos(label) − cos(background)))` per label, not a competing softmax over all labels.
**Reasoning:** Softmax treats labels as mutually exclusive — a photo with both "beach" and "sunset" loses probability for one when the other scores. Sigmoid assigns each label an independent probability, allowing co-occurring tags.
**Alternatives considered:** Softmax (superseded — caused saturated scores near 1.0 at the then-used LOGIT_SCALE=100, making the confidence threshold meaningless).
**Consequences:** Each label is scored independently. The `ai_tagging_confidence_threshold` (default 0.5) is the per-label sigmoid floor, not a top-1 gate.

### Anchor-relative softmax with un-saturated temperature for Smart Categorization
**Date:** 2025-xx-xx
**Status:** Active
**Decision:** Category classification uses softmax over (categories + background anchors) at temperature ≈40, not the shared CLIP logit scale of 100.
**Reasoning:** Temperature 100 saturated the softmax near 1.0, making the confidence gate (0.55) effectively useless. Temperature ≈40 produces a meaningful probability distribution.
**Alternatives considered:** Shared LOGIT_SCALE=100 (rejected — root cause of AI mis-classify bug; softmax saturated to ~1.0, no confidence discrimination).
**Consequences:** Confidence threshold and minimum margin gate are now genuinely discriminating.

### Quarantine folders, never delete
**Date:** 2024-xx-xx
**Status:** Active
**Decision:** Any file that cannot be placed correctly (unknown date, future date, duplicate, failed copy, corrupted) goes to a `_<reason>/` quarantine folder under the destination, never deleted.
**Reasoning:** Users must always be able to recover any file. A sorting tool that silently loses files is unacceptable.
**Alternatives considered:** Delete duplicates (rejected — irreversible, user might lose unique content).
**Consequences:** Destination directory accumulates quarantine subfolders (`_unknown_dates`, `_future_dates`, `_duplicates`, `_failed`, `_corrupted`) that users review manually.

### PyInstaller + bundled ffmpeg for self-contained releases
**Date:** 2024-xx-xx
**Status:** Active
**Decision:** Releases bundle the Python backend (PyInstaller) and static ffmpeg/ffprobe binaries. End users install nothing.
**Reasoning:** Target users are not technical. "Download and open" is the only acceptable UX.
**Alternatives considered:** System ffmpeg requirement (rejected — not reliably available on user machines); Docker (rejected — too heavy for a desktop tool).
**Consequences:** Native-only CI matrix (macOS arm64 + Intel, Windows x64). `scripts/fetch_ffmpeg.py` fetches static binaries. New packages with native extensions need `--collect-all=<pkg>` in the Makefile.
