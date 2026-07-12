.PHONY: install install-rust check-deps generate-icons dev backend frontend \
        test test-cov test-ci test-unit test-integration test-e2e test-services test-api \
        lint typecheck format clean \
        bundle-backend bundle-ffmpeg bundle-clip bundle-siglip bundle-portable \
        build build-tauri release \
        ci help

BACKEND   := backend
FRONTEND  := frontend
TAURI_RES := $(FRONTEND)/src-tauri/resources

# Static, self-contained ffmpeg + ffprobe are bundled by scripts/fetch_ffmpeg.py
# — the SINGLE cross-platform source of truth (download URLs + per-arch logic all
# live there), shared by local `make bundle-ffmpeg` AND the GitHub Actions release
# workflow so macOS / Windows / Linux can never drift apart. End users never need
# a system ffmpeg/ffprobe.
#
# Version overrides (all are optional — defaults are sensible):
#   make bundle-ffmpeg FFMPEG_MAC_VER=7.1.1
#   make bundle-ffmpeg FFMPEG_WIN_TAG=autobuild-2025-01-30-12-56  # pin Win build
FFMPEG_MAC_VER ?= 7.1.1
# Windows BtbN release tag; "latest" = continuously-updated rolling build.
# Override for reproducible builds: export FFMPEG_WIN_TAG=autobuild-YYYY-MM-DD-HH-MM
FFMPEG_WIN_TAG ?= latest

# ── Cross-platform detection ──────────────────────────────────────────────────
# The same Makefile drives NATIVE builds on macOS, Linux and Windows. On Windows
# it expects a bash env (Git Bash / MSYS2) so /bin/bash + coreutils resolve.
# `OS` is "Windows_NT" on Windows; elsewhere we ask uname. (It does NOT cross-
# compile — see the `release` target.)
ifeq ($(OS),Windows_NT)
  DETECTED_OS := Windows
  VENV_BIN    := Scripts
  EXE         := .exe
  SYS_PYTHON  := python
else
  DETECTED_OS := $(shell uname -s)
  VENV_BIN    := bin
  EXE         :=
  SYS_PYTHON  := python3
endif
ARCH := $(shell uname -m 2>/dev/null || echo unknown)

# Always use the project virtualenv so we never touch the system/Homebrew Python.
# Absolute path keeps the interpreter correct after `cd backend`. The venv tool
# dir is bin/ on Unix, Scripts/ on Windows; binaries gain .exe there.
VENV_PYTHON := $(CURDIR)/$(BACKEND)/.venv/$(VENV_BIN)/python$(EXE)
PYTHON      := $(shell test -x "$(VENV_PYTHON)" && echo "$(VENV_PYTHON)" || echo $(SYS_PYTHON))
# The ffmpeg fetch script is stdlib-only, so it can bootstrap before the venv exists.
BOOTSTRAP_PY := $(PYTHON)

# Make's default subshell is /bin/sh, which does NOT source ~/.zshrc / ~/.bashrc
# and therefore inherits no PATH augmentations the user adds for cargo, rustup,
# Homebrew, etc. The tauri CLI shells out to `cargo metadata` early on; if
# `~/.cargo/bin` isn't on PATH the user sees the cryptic
#     "failed to get cargo metadata: No such file or directory (os error 2)".
# We prepend the common rust + brew locations to PATH for every recipe that
# invokes Cargo, Tauri, or npm-scripts that ultimately invoke Cargo.
DEV_PATH := $$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$$PATH

# ── Help ──────────────────────────────────────────────────────────────────────

help:
	@echo "MediaSorter — development & release commands"
	@echo ""
	@echo "Setup:"
	@echo "  make check-deps         Verify all required tools are installed"
	@echo "  make install            Install all dependencies (backend + frontend)"
	@echo "  make install-rust       Install the Rust toolchain via rustup"
	@echo "  make generate-icons     Regenerate app icons (requires Pillow: pip install pillow)"
	@echo ""
	@echo "Development (requires Python, Node, Rust; ffmpeg on PATH only for media ops):"
	@echo "  make dev                Start backend + Tauri dev in one terminal (hot-reload)"
	@echo "  make backend            Run FastAPI only with hot-reload (port 8000)"
	@echo "  make frontend           Run Tauri dev only (spawns own backend without hot-reload)"
	@echo ""
	@echo "Testing:"
	@echo "  make test               Run all tests (verbose + coverage)"
	@echo "  make test-cov           Run tests → HTML coverage report (gate ≥80%)"
	@echo "  make test-ci            Run tests → XML coverage (mirrors GitHub Actions)"
	@echo "  make test-unit          Unit tests only  (test_services/)"
	@echo "  make test-integration   API integration tests  (test_api/)"
	@echo "  make test-e2e           End-to-end tests  (test_e2e/)"
	@echo ""
	@echo "Code quality:"
	@echo "  make lint               Ruff lint + format check"
	@echo "  make typecheck          mypy strict type-check"
	@echo "  make format             Auto-format in place"
	@echo ""
	@echo "Distribution builds (macOS / Windows):"
	@echo "  make bundle-backend        Freeze Python backend with PyInstaller"
	@echo "  make bundle-ffmpeg         Download static ffmpeg + ffprobe into the bundle (no system ffmpeg needed)"
	@echo "  make bundle-siglip         Bundle SigLIP 2 for offline high-tier AI (optional, ~200 MB; lazy-downloads otherwise)"
	@echo "  make bundle-portable       Create Windows portable ZIP (Windows only; after build-tauri)"
	@echo "  make build-tauri           Build Tauri app (requires bundled resources)"
	@echo "  make release               Full build: bundle-backend + bundle-ffmpeg + build-tauri [+ bundle-portable on Windows]"
	@echo ""
	@echo "CI gate (run before pushing):"
	@echo "  make ci                 lint + typecheck + test-ci"

# ── Dependency checks ─────────────────────────────────────────────────────────

# Emit a coloured ✓ / ✗ for each required tool and exit non-zero if any are missing.
# Honour the same augmented PATH the dev/build recipes use so a user who has
# cargo installed via rustup (but hasn't sourced ~/.cargo/env) still passes.
check-deps:
	@echo "==> Checking build dependencies ($(DETECTED_OS)/$(ARCH)) …"
	@export PATH="$(DEV_PATH)"; \
	ALL_OK=1; \
	require() { \
		if command -v "$$1" >/dev/null 2>&1; then \
			printf "  ✓  %-18s %s\n" "$$1" "$$($$1 --version 2>&1 | head -1)"; \
		else \
			printf "  ✗  %-18s NOT FOUND  (%s)\n" "$$1" "$$2"; \
			ALL_OK=0; \
		fi; \
	}; \
	optional() { \
		if command -v "$$1" >/dev/null 2>&1; then \
			printf "  ✓  %-18s %s\n" "$$1" "$$($$1 --version 2>&1 | head -1)"; \
		else \
			printf "  •  %-18s optional — %s\n" "$$1" "$$2"; \
		fi; \
	}; \
	require $(SYS_PYTHON) "install Python 3.10+"; \
	require node  "install Node.js 20+"; \
	require npm   "comes with Node.js"; \
	require cargo "run: make install-rust"; \
	optional ffmpeg  "bundled into releases; only needed on PATH for 'make dev'"; \
	optional ffprobe "bundled into releases; only needed on PATH for 'make dev'"; \
	if [ "$$ALL_OK" -eq 0 ]; then \
		echo ""; \
		echo "One or more REQUIRED tools are missing:"; \
		echo "  • Rust/Cargo: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"; \
		echo "  • Node/npm:   brew install node  (or https://nodejs.org)"; \
		echo ""; \
		exit 1; \
	fi; \
	echo ""; \
	echo "✓ All required build dependencies present."

# ── Setup ─────────────────────────────────────────────────────────────────────

install-rust:
	@echo "==> Installing Rust toolchain via rustup …"
	@if command -v cargo >/dev/null 2>&1; then \
		echo "  Rust is already installed: $$(cargo --version)"; \
	else \
		curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path; \
		echo ""; \
		echo "✓ Rust installed. Add Cargo to your shell:"; \
		echo "  echo 'export PATH=\"\$$HOME/.cargo/bin:\$$PATH\"' >> ~/.zshrc && source ~/.zshrc"; \
		echo ""; \
		echo "Then re-run: make install"; \
	fi

generate-icons:
	@echo "==> Generating app icons …"
	$(PYTHON) scripts/generate_icons.py
	@echo "✓ Icons written to frontend/src-tauri/icons/"

install:
	@# Rust check — give an actionable error rather than a cryptic Cargo message later.
	@if ! PATH="$(DEV_PATH)" command -v cargo >/dev/null 2>&1; then \
		echo ""; \
		echo "ERROR: Rust/Cargo is not installed or not on PATH."; \
		echo "  Run: make install-rust"; \
		echo "  Then add ~/.cargo/bin to PATH and re-run: make install"; \
		echo ""; \
		exit 1; \
	fi
	@# Create the virtualenv if it doesn't exist yet, then install everything into it.
	@test -d $(BACKEND)/.venv || $(SYS_PYTHON) -m venv $(BACKEND)/.venv
	$(BACKEND)/.venv/$(VENV_BIN)/python$(EXE) -m pip install --quiet --upgrade pip
	$(BACKEND)/.venv/$(VENV_BIN)/python$(EXE) -m pip install -e "$(BACKEND)/.[dev,local-ai]"
	cd $(FRONTEND) && npm install
	@echo ""
	@echo "✓ All dependencies installed."

# ── Development servers ───────────────────────────────────────────────────────

backend:
	cd $(BACKEND) && $(PYTHON) -m uvicorn app.main:app \
		--host 127.0.0.1 --port 8000 --reload --timeout-graceful-shutdown 3

frontend:
	cd $(FRONTEND) && PATH="$(DEV_PATH)" npm run tauri dev

dev:
	-cd $(FRONTEND) && PATH="$(DEV_PATH)" npm run dev:all

# ── Testing ───────────────────────────────────────────────────────────────────

test:
	cd $(BACKEND) && $(PYTHON) -m pytest tests/ -v \
		--cov=app --cov-report=term-missing

test-cov:
	cd $(BACKEND) && $(PYTHON) -m pytest tests/ -v \
		--cov=app \
		--cov-report=term-missing \
		--cov-report=html \
		--cov-fail-under=80
	@echo "HTML report: $(BACKEND)/htmlcov/index.html"

# Mirrors exactly what GitHub Actions runs (XML for upload-artifact)
test-ci:
	cd $(BACKEND) && $(PYTHON) -m pytest tests/ \
		--cov=app \
		--cov-report=xml \
		--cov-report=term-missing \
		--cov-fail-under=80

test-unit:
	cd $(BACKEND) && $(PYTHON) -m pytest \
		tests/test_services/ tests/test_config.py tests/test_extraction.py -v

test-integration:
	cd $(BACKEND) && $(PYTHON) -m pytest tests/test_api/ tests/test_health.py -v

test-e2e:
	cd $(BACKEND) && $(PYTHON) -m pytest tests/test_e2e/ -v -s

# Aliases
test-services: test-unit
test-api: test-integration

# ── Code quality ──────────────────────────────────────────────────────────────

lint:
	cd $(BACKEND) && $(PYTHON) -m ruff check app tests
	cd $(BACKEND) && $(PYTHON) -m ruff format --check app tests

typecheck:
	cd $(BACKEND) && $(PYTHON) -m mypy app

format:
	cd $(BACKEND) && $(PYTHON) -m ruff check --fix app tests
	cd $(BACKEND) && $(PYTHON) -m ruff format app tests

# ── CI gate ───────────────────────────────────────────────────────────────────

ci: lint typecheck test-ci
	@echo ""
	@echo "✓ All CI checks passed"

# ── Distribution: freeze Python backend with PyInstaller ─────────────────────
#
# Hidden-import cheat-sheet for the current stack (Python 3.13 / uvicorn 0.47 /
# FastAPI 0.136 / anyio 4.x / pydantic v2):
#
#  uvicorn.*          — entry-point sub-modules that uvicorn loads at runtime
#  anyio._backends.*  — anyio selects its backend dynamically; both must ship
#  email.*            — pulled in by httpx / starlette header handling
#
# --collect-all gathers every file (py, data, so) for packages that use
# importlib or have data files PyInstaller would otherwise miss.

bundle-backend:
	@echo "==> Freezing Python backend with PyInstaller …"
	cd $(BACKEND) && $(PYTHON) -m PyInstaller \
		--onedir \
		--name mediasort-backend \
		--noconfirm \
		--hidden-import=uvicorn.logging \
		--hidden-import=uvicorn.loops \
		--hidden-import=uvicorn.loops.auto \
		--hidden-import=uvicorn.protocols \
		--hidden-import=uvicorn.protocols.http \
		--hidden-import=uvicorn.protocols.http.auto \
		--hidden-import=uvicorn.protocols.websockets \
		--hidden-import=uvicorn.protocols.websockets.auto \
		--hidden-import=uvicorn.lifespan \
		--hidden-import=uvicorn.lifespan.on \
		--hidden-import=anyio._backends._asyncio \
		--hidden-import=anyio._backends._trio \
		--hidden-import=email.mime.text \
		--hidden-import=email.mime.multipart \
		--collect-all=piexif \
		--collect-all=imagehash \
		--collect-all=pillow_heif \
		--collect-all=rawpy \
		--collect-all=numpy \
		--collect-all=structlog \
		--collect-all=platformdirs \
		--collect-all=anyio \
		--collect-all=pydantic \
		--collect-all=fastapi \
		--collect-all=fastembed \
		--collect-all=onnxruntime \
		--collect-all=tokenizers \
		--collect-all=huggingface_hub \
		app/main.py
	@# Copy to resources and fix all permissions for Cargo build process.
	@# Every subdirectory of resources/ is gitignored, and git cannot track an
	@# empty directory — so resources/ itself does not exist in a clean checkout
	@# and `cp -R` would fail on the missing parent. It only ever worked locally
	@# because an earlier build had already created it.
	mkdir -p $(TAURI_RES)
	rm -rf $(TAURI_RES)/backend
	cp -R $(BACKEND)/dist/mediasort-backend $(TAURI_RES)/backend
	@# Fix permissions: Cargo's build.rs checks stat() on all files
	find $(TAURI_RES)/backend -type f -exec chmod 644 {} +
	find $(TAURI_RES)/backend -type d -exec chmod 755 {} +
	@# Ensure the executable is marked +x (required for release build)
	chmod 755 $(TAURI_RES)/backend/mediasort-backend$(EXE)
	@echo "✓ Backend frozen → $(TAURI_RES)/backend/"

# ── Distribution: bundle ffmpeg + ffprobe (all platforms) ────────────────────
#
# Downloads STATIC, self-contained ffmpeg AND ffprobe so the shipped app needs
# no system ffmpeg/ffprobe on the end user's machine. We deliberately do NOT
# copy `$(which ffmpeg)`: a Homebrew/apt ffmpeg is dynamically linked and crashes
# on any machine without an identical install. The backend uses BOTH binaries
# (ffmpeg: convert/repair; ffprobe: metadata, date extraction, video duplicate
# detection, validation), so both are always bundled.
#
# All the platform/arch logic lives in scripts/fetch_ffmpeg.py — the single
# source of truth shared by local builds AND the GitHub Actions release workflow,
# so macOS, Windows and Linux can never drift apart. The script is stdlib-only,
# so it runs even before the venv exists.

bundle-ffmpeg:
	@echo "==> Bundling static ffmpeg + ffprobe ($(DETECTED_OS)/$(ARCH)) …"
	FFMPEG_MAC_VER="$(FFMPEG_MAC_VER)" FFMPEG_WIN_TAG="$(FFMPEG_WIN_TAG)" \
		$(BOOTSTRAP_PY) scripts/fetch_ffmpeg.py --dest "$(TAURI_RES)/ffmpeg"

# ── Distribution: bundle the local CLIP model for offline AI tagging ─────────
#
# Downloads the CLIP image + text encoders (via fastembed) into resources/clip/.
# At runtime the Rust shell / LocalClipTagger points fastembed's cache_dir at
# this folder (MEDIASORT_CLIP_MODEL_DIR), so the offline "local" tagger works
# with zero network access. Requires the `local-ai` extra (installed by
# `make install`). The model is a few hundred MB of git-ignored build output.

bundle-clip:
	@echo "==> Bundling local CLIP model for offline AI tagging …"
	$(PYTHON) scripts/fetch_clip_model.py --dest "$(TAURI_RES)/clip"
	@echo "✓ CLIP model → $(TAURI_RES)/clip/"

# ── Distribution: bundle the SigLIP 2 model (optional, higher AI tier) ────────
#
# Bundles the SigLIP 2 base/16 ONNX towers + tokenizer into resources/siglip/ so
# the "Standard"/"Max" tiers work fully offline. NOT part of `make release` by
# default: AI is opt-in and the encoder lazily downloads SigLIP on first use, so
# the base installer stays slim. Run this explicitly to ship a fully-offline
# higher-quality build (adds ~200 MB). Requires the `local-ai` extra.

bundle-siglip:
	@echo "==> Bundling SigLIP 2 model for offline high-tier AI …"
	$(PYTHON) scripts/fetch_siglip_model.py --dest "$(TAURI_RES)/siglip"
	@echo "✓ SigLIP 2 model → $(TAURI_RES)/siglip/"

# ── Windows portable ZIP (run-in-place, no install required) ─────────────────
#
# Creates a self-contained ZIP that end users can extract and run directly
# without running an installer. The exe is placed in app/ so the Rust shell's
# path resolution (app_dir + "../resources/resources/*") resolves correctly:
#
#   MediaSorter-portable/
#     app/MediaSorter.exe            ← launch this
#     resources/resources/backend/   ← frozen Python backend
#     resources/resources/ffmpeg/    ← bundled ffmpeg + ffprobe
#
# This target is a no-op on non-Windows systems (macOS/Linux don't need it).
# It requires build-tauri to have run first (the exe must already exist).

bundle-portable:
ifeq ($(DETECTED_OS),Windows)
	@echo "==> Creating Windows portable ZIP …"
	$(PYTHON) scripts/make_portable_zip.py
	@echo "✓ Portable ZIP → $(FRONTEND)/src-tauri/target/release/bundle/portable/"
else
	@echo "  (bundle-portable is Windows-only — skipping on $(DETECTED_OS))"
endif

# ── Full release builds ───────────────────────────────────────────────────────
#
# `make release` produces self-contained distributables for the CURRENT OS:
#   macOS   → .dmg (+ .app inside)
#   Windows → NSIS .exe installer  +  portable .zip (run-in-place, no install)
#   Linux   → .deb / .AppImage
#
# It does NOT cross-compile. PyInstaller freezes the Python backend — numpy,
# rawpy/libraw, pillow-heif as native binaries — for the HOST OS only.
# To ship every OS from one place, push a `v*` tag and let the GitHub Actions
# matrix build each one natively (see .github/workflows/release.yml).

release: check-deps bundle-backend bundle-ffmpeg bundle-clip build-tauri bundle-portable
	@echo ""
	@echo "✓✓✓ Release build complete for $(DETECTED_OS)! ✓✓✓"
	@echo ""
	@echo "📦 Distributables are under:"
	@echo "    $(FRONTEND)/src-tauri/target/release/bundle/"
	@BUNDLE="$(FRONTEND)/src-tauri/target/release/bundle"; \
	if [ "$(DETECTED_OS)" = "Windows" ]; then \
		echo "  • MSI      : $$BUNDLE/msi/*.msi"; \
		echo "  • Installer: $$BUNDLE/nsis/*-setup.exe"; \
		echo "  • Portable : $$BUNDLE/portable/*.zip  (run-in-place, no install)"; \
	elif [ "$(DETECTED_OS)" = "Darwin" ]; then \
		echo "  • DMG : $$BUNDLE/dmg/*.dmg"; \
		echo "  • App : $$BUNDLE/macos/MediaSorter.app"; \
	else \
		echo "  • see $$BUNDLE/ (deb / appimage)"; \
	fi
	@echo ""
	@echo "📝 To build for ALL operating systems, push a git tag:"
	@echo "     git tag v0.1.0 && git push origin v0.1.0"
	@echo "   GitHub Actions then builds macOS + Windows natively in parallel."

# ── Tauri desktop build (assumes resources are bundled in resources/) ────────

build-tauri:
	@# Check Cargo is available (look in the augmented PATH so users who have
	@# cargo installed via rustup don't have to source ~/.cargo/env first).
	@if ! PATH="$(DEV_PATH)" command -v cargo >/dev/null 2>&1; then \
		echo ""; \
		echo "ERROR: Cargo is not on PATH"; \
		echo ""; \
		echo "  Fix: source ~/.cargo/env"; \
		echo "       then re-run: make release"; \
		echo ""; \
		exit 1; \
	fi
	@# Verify resources exist
	@if [ ! -d "$(TAURI_RES)/backend" ] || [ ! -d "$(TAURI_RES)/ffmpeg" ]; then \
		echo ""; \
		echo "ERROR: Resources not bundled"; \
		echo ""; \
		echo "  Run: make bundle-backend && make bundle-ffmpeg"; \
		echo "       then: make build-tauri"; \
		echo ""; \
		exit 1; \
	fi
	@echo "Building Tauri app…"
	cd $(FRONTEND) && PATH="$(DEV_PATH)" npm run tauri build
	@# macOS post-processing only — these blocks no-op on Windows/Linux (the .app
	@# path won't exist there, and the unmount is guarded by a uname check).
	@# Fix executable permissions after Tauri bundling (Tauri resets them)
	@if [ -f "$(FRONTEND)/src-tauri/target/release/bundle/macos/MediaSorter.app/Contents/Resources/resources/backend/mediasort-backend" ]; then \
		chmod 755 "$(FRONTEND)/src-tauri/target/release/bundle/macos/MediaSorter.app/Contents/Resources/resources/backend/mediasort-backend"; \
		chmod 755 "$(FRONTEND)/src-tauri/target/release/bundle/macos/MediaSorter.app/Contents/Resources/resources/ffmpeg/ffmpeg"; \
		chmod 755 "$(FRONTEND)/src-tauri/target/release/bundle/macos/MediaSorter.app/Contents/Resources/resources/ffmpeg/ffprobe"; \
		echo "✓ Fixed executable permissions in .app bundle"; \
	fi
	@# Unmount DMG if it was auto-mounted (macOS Finder behavior)
	@if [ "$$(uname)" = "Darwin" ]; then \
		for mount in /Volumes/MediaSorter*; do \
			if [ -d "$$mount" ]; then \
				echo "Unmounting $$mount…"; \
				hdiutil detach "$$mount" 2>/dev/null || true; \
			fi; \
		done; \
	fi
	@echo ""
	@echo "✓ Build complete!"

# Legacy alias for backwards compatibility
build: build-tauri

# ── Cleanup ───────────────────────────────────────────────────────────────────

clean:
	find $(BACKEND) -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
	find $(BACKEND) -name "*.pyc" -delete 2>/dev/null || true
	rm -rf $(BACKEND)/.mypy_cache \
	       $(BACKEND)/.pytest_cache \
	       $(BACKEND)/htmlcov \
	       $(BACKEND)/coverage.xml \
	       $(BACKEND)/.coverage \
	       $(BACKEND)/dist \
	       $(BACKEND)/build \
	       $(BACKEND)/mediasort-backend.spec \
	       $(TAURI_RES)/backend \
	       $(TAURI_RES)/ffmpeg \
	       $(FRONTEND)/src-tauri/target/release/bundle/portable
