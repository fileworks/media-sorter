# Content identity and destructive proof

Media Sorter deliberately separates fast cache identity from proof that can
authorize a destructive action.

| Consumer | Identity | Role | Invalidated when |
| --- | --- | --- | --- |
| Catalog hashes and media facts | Catalog fingerprint v2 | Cache hint | Size, mtime, change time, file identity, or the platform sample changes |
| Catalog duplicate index | Current catalog fingerprint plus stored SHA-256 | Candidate hint | The catalog fingerprint/version changes; execution still rehashes |
| Thumbnail cache | Thumbnail key v2 with metadata and bounded byte samples | Display-only cache hint | Metadata, sample, renderer, requested size, or path changes |
| Frozen sort plan | Source fingerprint v2 | Preview-drift hint | Size, mtime, change time, or file identity changes |
| Resume checkpoint | Catalog schema and algorithm versions | Compatibility hint | A recorded schema, profile, root, or algorithm version changes |
| Verified transfer/quarantine | Fresh streaming SHA-256 with pre/post stat checks | Destructive proof | The digest differs or the source identity changes during validation |

`cache_hint` values reduce work on unchanged scans. They are never promoted to
destructive proof. Legacy catalog rows retain their file-presence information
but become lazy cache misses, so their derived facts are recomputed without
mistaking files for missing or deleting old rows.

Before a move or quarantine removes a source, the transfer layer reopens the
regular file, streams all bytes through SHA-256 with bounded memory, and
compares metadata and filesystem identity before and after the read. A
cross-volume action hashes during the staged copy and independently hashes the
closed stage. The source is retained whenever validation, publication, or
journalling does not complete.

The v2 cache hint uses change time on POSIX. On Windows, where `ctime` can mean
creation time, discovery also hashes bounded first/last byte samples. Network
filesystems can expose weaker or server-specific metadata; this affects cache
hit rates only because destructive actions always use the full-digest protocol.

## Scale budgets

Run the deterministic identity benchmark with:

```bash
backend/.venv/bin/python scripts/benchmark_content_identity.py
```

It executes 100,000-, 500,000-, and two-million-record cache-hint streams
without retaining one object per record, then performs a fresh 64 MiB
destructive-boundary hash. The reviewed budgets are at least 100,000 cache
hints/second, at most 2 MiB peak traced memory for the stream, at least
20 MiB/second for full hashing, and one progress event per 1 MiB chunk. These
are regression budgets rather than promises about a particular NAS.

Unchanged rescans remain metadata-only on POSIX and read bounded first/last
samples on Windows. A changed cache hint invalidates derived facts lazily. A
destructive preflight always reads the complete file, so its I/O cost is exactly
one source pass before a same-volume move and the staged-copy verification
passes documented in the transfer protocol.
