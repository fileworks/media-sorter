# Architecture ownership and growth reviews

Media Sorter keeps high-change code behind four explicit seams:

| Area | Owns | Does not own |
| --- | --- | --- |
| Release integrity | Package layout, checksums, signing state, provenance, packaged startup and native-tool smoke tests | Downloading or extracting native tools |
| Native tool supply chain | Immutable source selection, archive validation, digest verification, staging and atomic publication | Installer signing or upload |
| Review execution | Frozen snapshot preflight, fresh duplicate proof, action execution and reconciliation | Duplicate discovery or UI presentation |
| Desktop navigation | Stage routing, global operation state and lazy panel composition | Panel-specific lists, forms or data transforms |

The release-integrity module remains cohesive because all of its checks consume
one package/signing contract. Native download and extraction are already split
behind `fetch_ffmpeg.py` and the reviewed source manifest. UI panels and
backend identity/catalog logic remain separate modules.

`module-growth-policy.json` records review points for these modules.
`scripts/check_module_growth.py` emits advisory warnings when one passes its
reviewed point. It deliberately does not fail on a line count: a split requires
a real responsibility boundary. Generated locks, localized message catalogues,
and bundled concept catalogues are listed as static-data exemptions.
