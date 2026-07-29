# Photo-burst review

Burst detection is optional and off by default. It is separate from exact and
similar duplicate detection because burst frames are legitimate alternatives,
not redundant copies.

A group is created only when all three signals agree:

1. consecutive capture times are within the configured window (three seconds by
   default);
2. a burst-specific perceptual-hash distance passes (four bits by default,
   tighter and independent from similar-media matching);
3. camera make/model identity is the same.

Exact duplicates are removed from consideration first. A media unit is one frame,
so its RAW sibling, motion component, or sidecar follows the primary as a whole.
If burst detection is disabled, none of this metadata, perceptual, or sharpness
work runs.

Only candidate groups receive a reduced-resolution variance-of-Laplacian
sharpness score. The highest score is preselected, but sharpness measures edge
contrast—not aesthetics, faces, smiles, composition, or intent. An unreadable
score is displayed as unknown and ranks after measured frames.

Every group requires review. The user can keep another frame, keep several, or
dismiss the group and keep everything. A decision cannot produce any action
before review. Non-selected whole units are proposed for the ordinary quarantine
path and are never deleted.
