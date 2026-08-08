# Changelog

All notable changes to MediaSorter are documented here.
This file is generated from [Conventional Commits](https://www.conventionalcommits.org/) by release-it; do not edit it by hand.

## [1.3.0](https://github.com/fileworks/media-sorter/compare/v1.2.5...v1.3.0) (2026-08-08)

### Features

* complete the reviewed five-stage lifecycle ([#59](https://github.com/fileworks/media-sorter/issues/59)) ([977e2d6](https://github.com/fileworks/media-sorter/commit/977e2d6e4fa4de7ab5b3e85bf8d01c1fe5d9faeb))

### Bug Fixes

* **release:** configure automated commit identity ([#60](https://github.com/fileworks/media-sorter/issues/60)) ([804aa73](https://github.com/fileworks/media-sorter/commit/804aa7382360fad889146c20717d8c4e57da550e))

## [1.2.5](https://github.com/fileworks/media-sorter/compare/v1.2.4...v1.2.5) (2026-08-02)


### Bug Fixes

* reap backend after packaged WebView smoke ([#56](https://github.com/fileworks/media-sorter/issues/56)) ([1ed2156](https://github.com/fileworks/media-sorter/commit/1ed2156be55cd51115a33c86b83e05f1f765fdae))

## [1.2.4](https://github.com/fileworks/media-sorter/compare/v1.2.3...v1.2.4) (2026-08-01)


### Bug Fixes

* run package checks in project environment ([#55](https://github.com/fileworks/media-sorter/issues/55)) ([1fb3cf4](https://github.com/fileworks/media-sorter/commit/1fb3cf487dbacebc08c0982d4483696f16ad1419))

## [1.2.3](https://github.com/fileworks/media-sorter/compare/v1.2.2...v1.2.3) (2026-08-01)


### Bug Fixes

* bound storage analysis and verify packaged releases ([#41](https://github.com/fileworks/media-sorter/issues/41)) ([a566070](https://github.com/fileworks/media-sorter/commit/a56607021ee9c9d9ef6ecfefac23735cb75cc69e))

## [1.2.2](https://github.com/fileworks/media-sorter/compare/v1.2.1...v1.2.2) (2026-08-01)


### Bug Fixes

* authenticate packaged backend health smoke ([#39](https://github.com/fileworks/media-sorter/issues/39)) ([039a558](https://github.com/fileworks/media-sorter/commit/039a558ffe09950abb8a8e39dd7b74a7d825c0b3))

## [1.2.1](https://github.com/fileworks/media-sorter/compare/v1.2.0...v1.2.1) (2026-08-01)


### Bug Fixes

* run native release gate on shipped macOS ([#38](https://github.com/fileworks/media-sorter/issues/38)) ([bb0bcaa](https://github.com/fileworks/media-sorter/commit/bb0bcaaf4ef4d72fdd15930f0ff7a0db389234e4))

# [1.2.0](https://github.com/fileworks/media-sorter/compare/v1.1.7...v1.2.0) (2026-08-01)


### Features

* secure local API and bound catalog operations ([#37](https://github.com/fileworks/media-sorter/issues/37)) ([43977e3](https://github.com/fileworks/media-sorter/commit/43977e302f8da60ee6ae36e9e395269f53bb3a9f))

## [1.1.7](https://github.com/fileworks/media-sorter/compare/v1.1.6...v1.1.7) (2026-07-30)


### Bug Fixes

* normalise line endings when merging checksums ([#36](https://github.com/fileworks/media-sorter/issues/36)) ([72daecb](https://github.com/fileworks/media-sorter/commit/72daecb1e638fe63d36592053c496a16876c573d))

## [1.1.6](https://github.com/fileworks/media-sorter/compare/v1.1.5...v1.1.6) (2026-07-30)


### Bug Fixes

* publish one checksum file covering every installer ([#35](https://github.com/fileworks/media-sorter/issues/35)) ([9adf973](https://github.com/fileworks/media-sorter/commit/9adf973226066dd5f9c97493e75cf306e450e7c7))

## [1.1.5](https://github.com/fileworks/media-sorter/compare/v1.1.4...v1.1.5) (2026-07-30)


### Bug Fixes

* bundle resources with the layout the packager expects ([#34](https://github.com/fileworks/media-sorter/issues/34)) ([f301385](https://github.com/fileworks/media-sorter/commit/f3013855d46067b7f6ddfba0bef392a6ed0b53d1))

## [1.1.4](https://github.com/fileworks/media-sorter/compare/v1.1.3...v1.1.4) (2026-07-30)


### Bug Fixes

* bundle every resource again, not two globs one of which matches nothing ([#33](https://github.com/fileworks/media-sorter/issues/33)) ([69a59c4](https://github.com/fileworks/media-sorter/commit/69a59c46f4bb3094736f4d4ae0b8780a31a5a6cb))

## [1.1.3](https://github.com/fileworks/media-sorter/compare/v1.1.2...v1.1.3) (2026-07-30)


### Bug Fixes

* stop the new cargo gate from blocking every release ([#32](https://github.com/fileworks/media-sorter/issues/32)) ([4e8a3b4](https://github.com/fileworks/media-sorter/commit/4e8a3b40a357f586a0047def0653693718653b1a))

## [1.1.2](https://github.com/fileworks/media-sorter/compare/v1.1.1...v1.1.2) (2026-07-30)


### Bug Fixes

* verify the rust source after every resource it depends on ([#31](https://github.com/fileworks/media-sorter/issues/31)) ([f0eeac4](https://github.com/fileworks/media-sorter/commit/f0eeac4fc2c489dce223cbdc0edbeda060934337))

## [1.1.1](https://github.com/fileworks/media-sorter/compare/v1.1.0...v1.1.1) (2026-07-30)


### Bug Fixes

* verify the rust source after the backend bundle, not before ([#22](https://github.com/fileworks/media-sorter/issues/22)) ([e9a5cf6](https://github.com/fileworks/media-sorter/commit/e9a5cf6b735c125a03cbf1b129a1be2db970c542))

# [1.1.0](https://github.com/fileworks/media-sorter/compare/v1.0.6...v1.1.0) (2026-07-30)


### Features

* deliver guided media review workflow and on-demand local AI models ([#14](https://github.com/fileworks/media-sorter/issues/14)) ([39396d6](https://github.com/fileworks/media-sorter/commit/39396d650e02219cb0f560063ee3c30537027bdf)), closes [#12](https://github.com/fileworks/media-sorter/issues/12)

## [1.0.6](https://github.com/fileworks/media-sorter/compare/v1.0.5...v1.0.6) (2026-07-23)


### Bug Fixes

* **windows:** correct NSIS installMode schema value; add Tauri CI check ([#7](https://github.com/fileworks/media-sorter/issues/7)) ([c5b7429](https://github.com/fileworks/media-sorter/commit/c5b7429fb1a99a9cb0c3484826c31dbf29e9fa14))

## [1.0.5](https://github.com/fileworks/media-sorter/compare/v1.0.4...v1.0.5) (2026-07-23)


### Bug Fixes

* **windows:** correct resource paths and enable per-machine NSIS install ([#6](https://github.com/fileworks/media-sorter/issues/6)) ([44d1f9f](https://github.com/fileworks/media-sorter/commit/44d1f9f14a6143c960388cfe96260b9a7c9fbc8e))

## [1.0.4](https://github.com/fileworks/media-sorter/compare/v1.0.3...v1.0.4) (2026-07-14)


### Bug Fixes

* **sorting:** fail loudly when the source folder is missing ([#5](https://github.com/fileworks/media-sorter/issues/5)) ([5af072d](https://github.com/fileworks/media-sorter/commit/5af072d4e21f8cc7e88f6c2d38e0fcb64b8a604e))

## [1.0.3](https://github.com/fileworks/media-sorter/compare/v1.0.2...v1.0.3) (2026-07-13)


### Bug Fixes

* **build:** UTF-8 for all build scripts + replace the retired macos-13 runner ([#4](https://github.com/fileworks/media-sorter/issues/4)) ([0718ad8](https://github.com/fileworks/media-sorter/commit/0718ad81366b1527083f9e59a2c837cce3a7a2f3))

## [1.0.2](https://github.com/fileworks/media-sorter/compare/v1.0.1...v1.0.2) (2026-07-13)


### Bug Fixes

* **build:** force UTF-8 stdout so the Windows release build survives ([#3](https://github.com/fileworks/media-sorter/issues/3)) ([7b4770f](https://github.com/fileworks/media-sorter/commit/7b4770ffcf04a096fe2ac79e3780bad90868bd5b))

## [1.0.1](https://github.com/fileworks/media-sorter/compare/v1.0.0...v1.0.1) (2026-07-12)


### Bug Fixes

* **build:** create resources/ before bundling the backend ([#2](https://github.com/fileworks/media-sorter/issues/2)) ([17b6171](https://github.com/fileworks/media-sorter/commit/17b6171b883e05e78b83e53cb395567ee872fcf9))

# 1.0.0 (2026-07-12)


### Bug Fixes

* OS-assigned backend port, mypy under CI's dep set, update-check repo ([#1](https://github.com/fileworks/media-sorter/issues/1)) ([fcd1480](https://github.com/fileworks/media-sorter/commit/fcd14804f76ddb2966352eac9c40db6f64accccb))
* remove .mex and .playwright-mcp ([edf6b1a](https://github.com/fileworks/media-sorter/commit/edf6b1af4938b08055d051aa4bb115a588b5302a))
