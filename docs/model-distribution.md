# Optional model distribution

MediaSorter downloads optional CLIP and SigLIP files only after an explicit
Install action. The application manifest pins every upstream object to an
immutable commit, byte size, and SHA-256 digest. Installed packs remain usable
offline and can be removed from the settings screen.

## Hosting decision

Fileworks will not redistribute these model weights from a first-party GitHub
Release or CDN for now. The packs are roughly 608 MB and 413 MB, come from
separate upstream projects with their own licence and notice obligations, and
would add a material bandwidth, availability, and supply-chain maintenance
commitment. The immutable Hugging Face revisions remain the default source.

This is an operational decision, not a trust compromise: the bundled hashes are
the trust root, so a future mirror cannot change accepted bytes. Organizations
that need their own availability boundary can set
`MEDIASORT_MODEL_MIRROR_URL` to an HTTPS endpoint using the documented
`<pack>/<component>/<path>` layout. Local HTTP remains restricted to test
servers.

Release CI exercises install, interrupted range resume, cancellation, offline
relaunch, and removal on the native macOS and Windows package hosts. It also
proves that no optional model bytes enter the DMG, MSI, NSIS, or portable ZIP.
