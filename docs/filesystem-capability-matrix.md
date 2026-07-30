# Filesystem Preservation Capability Matrix

MediaSorter must probe the actual destination filesystem. An operating-system
label alone is not proof of timestamp precision, atomic promotion, extended
attributes, or cross-volume behavior.

| Capability | Windows lane | macOS lane | Linux lane | Runtime decision |
| --- | --- | --- | --- | --- |
| Timestamp round-trip and precision | Required | Required | Required | Measure requested and observed nanoseconds |
| Permissions/mode | Limited/applicable attributes | POSIX mode | POSIX mode | Report supported, unsupported, or permission denied |
| Windows file attributes | Required | Not applicable | Not applicable | Read platform file-attribute evidence |
| Extended attributes | Filesystem-specific | Required probe | Required probe | Never assume support from API presence |
| Same-directory rename | Required | Required | Required | Isolated rename probe on target filesystem |
| Existing-file replace | Required | Required | Required | Isolated replace probe on target filesystem |
| Flush and file `fsync` | Required | Required | Required | Failure blocks a strong staged-commit claim |
| Sparse files | Filesystem-specific | Filesystem-specific | Filesystem-specific | Compare logical and allocated bytes where exposed |
| Symlink/reparse creation | Privilege/filesystem-specific | Required probe | Required probe | Used as defense evidence, never followed implicitly |
| FIFO/special files | Not applicable | Required probe | Required probe | Special inputs are excluded from media transfer |
| Cross-root rename | Required with separate volume fixture | Required with separate volume fixture | Required with separate mount fixture | Record device identity and observed rename result |

The executable harness is
`backend/app/core/filesystem_capabilities.py`, with platform-contract and
runtime-volume tests in `backend/tests/test_filesystem_capabilities.py`.
Cross-volume CI must provide two roots proven to have different device
identities; a pair of directories on one device is explicitly recorded as
same-device evidence and must not satisfy the cross-volume release gate.
