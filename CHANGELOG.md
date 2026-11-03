# Changelog

All notable changes to MediaSorter are documented here.
This file is generated from [Conventional Commits](https://www.conventionalcommits.org/) by release-it; do not edit it by hand.

## [2.0.0](https://github.com/fileworks/media-sorter/compare/v1.1.0...v2.0.0) (2026-11-03)

### ⚠ BREAKING CHANGES

* **ci:** restore secure bounded validation ([#143](https://github.com/fileworks/media-sorter/issues/143))

### Bug Fixes

* **build:** verify and narrow the frozen runtime ([#146](https://github.com/fileworks/media-sorter/issues/146)) ([023fbbb](https://github.com/fileworks/media-sorter/commit/023fbbb61e4832d841062b3b8595f0db6d47f002))
* **ci:** cache release validation tooling consistently ([#144](https://github.com/fileworks/media-sorter/issues/144)) ([8e15536](https://github.com/fileworks/media-sorter/commit/8e1553609201c0eab8fba91158487335ae3de105))
* **ci:** make macOS npm install-script policy explicit ([#147](https://github.com/fileworks/media-sorter/issues/147)) ([b93248d](https://github.com/fileworks/media-sorter/commit/b93248d0d24bd336b637be35c597ef5742894782))
* **ci:** restore secure bounded validation ([#143](https://github.com/fileworks/media-sorter/issues/143)) ([7499d86](https://github.com/fileworks/media-sorter/commit/7499d86b506c7453d3ad89aee15b93dc01058282))
* **deps:** apply reviewed November updates ([#150](https://github.com/fileworks/media-sorter/issues/150)) ([3e2a641](https://github.com/fileworks/media-sorter/commit/3e2a6418daf9608f1de7d6c83c65f85fe6fae823))
* **deps:** pin dependencies ([#129](https://github.com/fileworks/media-sorter/issues/129)) ([2366d33](https://github.com/fileworks/media-sorter/commit/2366d33a16ef3f035f1cee81d95b319d7aeaa335))
* **deps:** pin direct Python and Cargo dependencies so Renovate lanes resolve ([#134](https://github.com/fileworks/media-sorter/issues/134)) ([2a79335](https://github.com/fileworks/media-sorter/commit/2a79335ff727b2c6ee931267453e869f1f3814aa)), references [renovatebot/renovate#41624](https://github.com/renovatebot/renovate/issues/41624) [#129](https://github.com/fileworks/media-sorter/issues/129) [#131](https://github.com/fileworks/media-sorter/issues/131)
* **deps:** replace yanked async-executor ([#149](https://github.com/fileworks/media-sorter/issues/149)) ([8bcd3eb](https://github.com/fileworks/media-sorter/commit/8bcd3eb9abf49294b35c68ac202ebe2b077373b7))
* **deps:** update weekly ci updates ([#137](https://github.com/fileworks/media-sorter/issues/137)) ([c5f3808](https://github.com/fileworks/media-sorter/commit/c5f3808599133f0b8481349cb672785085ad71d6))
* **deps:** update weekly javascript updates ([#130](https://github.com/fileworks/media-sorter/issues/130)) ([28652f7](https://github.com/fileworks/media-sorter/commit/28652f7a36fe8e0b590a1cf06a3daedd8dc1f993))
* **deps:** update weekly python updates ([#132](https://github.com/fileworks/media-sorter/issues/132)) ([660f636](https://github.com/fileworks/media-sorter/commit/660f6362c5686de50c96c4482c40a0b2aa981efb))
* **deps:** update weekly rust updates ([#131](https://github.com/fileworks/media-sorter/issues/131)) ([4418d79](https://github.com/fileworks/media-sorter/commit/4418d79081a3e38ae28250e5c65cd056b5e86a85))
* **deps:** update weekly tauri updates ([#133](https://github.com/fileworks/media-sorter/issues/133)) ([28efc62](https://github.com/fileworks/media-sorter/commit/28efc62edb3c675b43d2741b7dfe43991f0013f3))
* **release:** pass app notarization credentials ([#148](https://github.com/fileworks/media-sorter/issues/148)) ([1d67919](https://github.com/fileworks/media-sorter/commit/1d67919be10f4b9da20bed0d417a3fba4c16d1a8))
* **security:** audit every locked platform and runtime variant ([#145](https://github.com/fileworks/media-sorter/issues/145)) ([da9a1d8](https://github.com/fileworks/media-sorter/commit/da9a1d8212fa99b341fca07ae48c5e2d76cfe493))

## [1.1.0](https://github.com/fileworks/media-sorter/compare/v1.0.6...v1.1.0) (2026-10-18)

### Bug Fixes

* apply the 2026-10-11 review safety and launch fixes ([#119](https://github.com/fileworks/media-sorter/issues/119)) ([c827bef](https://github.com/fileworks/media-sorter/commit/c827bef517fa1aedc1b1985b0be5bb01fff5515a))
* **deps:** patch shell-quote, source-map-js and postcss-selector-parser ([#124](https://github.com/fileworks/media-sorter/issues/124)) ([54b38cd](https://github.com/fileworks/media-sorter/commit/54b38cd470431932727c47abf829a05ef4c8d978))
* **deps:** update rustls to 0.23.46 ([#122](https://github.com/fileworks/media-sorter/issues/122)) ([aea8b78](https://github.com/fileworks/media-sorter/commit/aea8b78ab22d8cae87d65a870ccd2a6a267801f5))
* **release:** seal macOS frameworks and survive rate-limited ffmpeg hosts ([#123](https://github.com/fileworks/media-sorter/issues/123)) ([0a9951f](https://github.com/fileworks/media-sorter/commit/0a9951f1a47c9c027f8abc99724d0d2fc2751589))
* **release:** verify macOS framework copies once and fetch Intel ffmpeg from GitHub ([#125](https://github.com/fileworks/media-sorter/issues/125)) ([bf04d7c](https://github.com/fileworks/media-sorter/commit/bf04d7c562039ef2dfd8a0cac64cda336f8e9285))
* **release:** wait for WebView2 before smoke cleanup and gate tags on a green candidate ([#126](https://github.com/fileworks/media-sorter/issues/126)) ([a239d42](https://github.com/fileworks/media-sorter/commit/a239d422700f7023bececd2f6b52b209a28ed59f))

## [1.0.6](https://github.com/fileworks/media-sorter/compare/v1.0.5...v1.0.6) (2026-10-05)

### Bug Fixes

* clarify review and centralize duplicate copies ([b353976](https://github.com/fileworks/media-sorter/commit/b353976d7e044bf7883ee1f96a2c28ee8a3ab016))

## [1.0.5](https://github.com/fileworks/media-sorter/compare/v1.0.4...v1.0.5) (2026-10-05)

### Bug Fixes

* restore previous progress before opening the workflow ([bc12a58](https://github.com/fileworks/media-sorter/commit/bc12a5820c079da0de9b47859ba47a2cad2d0438))

## [1.0.4](https://github.com/fileworks/media-sorter/compare/v1.0.3...v1.0.4) (2026-10-05)

### Bug Fixes

* **ci:** retry mapped WebView2 metrics cleanup ([04bedc0](https://github.com/fileworks/media-sorter/commit/04bedc05799ffc854b356e55a0d6a9d4a54276ee))
* explain associated files and preview confirmed copies in their folders ([5d3b1ec](https://github.com/fileworks/media-sorter/commit/5d3b1ec15589ac630dde508249660b20e2089c19))

## [1.0.3](https://github.com/fileworks/media-sorter/compare/v1.0.2...v1.0.3) (2026-10-05)

### Bug Fixes

* reviewed duplicate destinations and complete desktop shutdown ([dd708ee](https://github.com/fileworks/media-sorter/commit/dd708ee392d03a56fd79d17fd2c3d124ab9182cd))

## [1.0.2](https://github.com/fileworks/media-sorter/compare/v1.0.1...v1.0.2) (2026-10-05)

### Bug Fixes

* handle the Windows per-user Programs fallback ([3568ee1](https://github.com/fileworks/media-sorter/commit/3568ee14f039807e02a36aa1d92c35fb83a55a8f))
* Windows startup, previews and workflow continuity ([cc6a5bd](https://github.com/fileworks/media-sorter/commit/cc6a5bd8cd8be98072f38c64f2f901537d72a5ce))

## [1.0.1](https://github.com/fileworks/media-sorter/compare/v1.0.0...v1.0.1) (2026-10-04)

### Bug Fixes

* repair Windows startup and container health ([a96f847](https://github.com/fileworks/media-sorter/commit/a96f84789143afcc86de714d5b15fdef58d6594b))
* **updates:** honor live settings and releases ([5e47b44](https://github.com/fileworks/media-sorter/commit/5e47b444f921b3cb2d30e40ecad2183b1f42c985))
* validate original NSIS install destination ([d19510e](https://github.com/fileworks/media-sorter/commit/d19510ef2f5720e34219a64b52a21a6c33ed33c7))
* **windows:** guard install paths and startup ([5463ea1](https://github.com/fileworks/media-sorter/commit/5463ea1ae42be8ccc93574e941e40b2e5bd41338))

## [1.0.0] (2026-10-02)

Initial Fileworks baseline, preserving the reviewed working implementation.
Generated AI-first. Earlier beta history is retained in private recovery archives.
