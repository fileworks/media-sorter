# Install MediaSorter

Source and installers are public. No account, Python, Node or ffmpeg installation
is required for desktop use. Download from [official releases](https://github.com/fileworks/media-sorter/releases).
The v1.0.0 assets are:

| Device | File | Use |
|---|---|---|
| Windows x64 | `MediaSorter_1.0.0_x64-setup.exe` | Normal installer |
| Windows x64 | `MediaSorter_1.0.0_x64_en-US.msi` | MSI deployment |
| Windows x64 | `MediaSorter-portable.zip` | Extract the entire ZIP; run the app in that folder |
| macOS 12+, Apple Silicon | `MediaSorter_1.0.0_aarch64.dmg` | Open DMG; drag the app into Applications |
| macOS 12+, Intel | `MediaSorter_1.0.0_x64.dmg` | Open DMG; drag the app into Applications |

On a Mac, **About This Mac** identifies Apple Silicon versus Intel. Native
Windows ARM and Linux desktop installers are not provided by this release.

## Verify and launch

Download `SHA256SUMS` from the same release. Compute the chosen file's hash and
compare it with its filename's entry before opening:

```powershell
# Windows PowerShell, from Downloads; substitute your chosen filename.
Get-FileHash .\MediaSorter_1.0.0_x64-setup.exe -Algorithm SHA256
Get-Content .\SHA256SUMS
```

```sh
# macOS Terminal, from Downloads; substitute your chosen filename.
shasum -a 256 MediaSorter_1.0.0_aarch64.dmg
cat SHA256SUMS
```

Checksums detect different bytes; they do not establish publisher identity.
Installers are unsigned. Follow the current platform-specific trust prompts in
[README Install](../README.md#install) only for a verified official download.
Open MediaSorter, select **Copy** on 20 disposable photos and review the result.

## Updates and other modes

For an update, download and verify the newer installer from the official release;
close the running app and install it. Keep backups of media and application state.
Portable installations must keep the whole extracted bundle together.

For source development use [development setup](development.md#setup), including
Windows commands. [Headless/CLI setup](headless.md) is an advanced source mode,
not a prebuilt NAS package or a substitute for the desktop installation.
