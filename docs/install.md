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

### Windows installation directory

Use a dedicated application folder: normally `%LOCALAPPDATA%\Programs\MediaSorter`
for the user installation or `C:\Program Files\MediaSorter` for all users.
The NSIS installer offers both scopes (its scope selector requires elevation).
MSI is the machine deployment route. Choose one installer type for subsequent
updates. The installer, resources and `uninstall.exe` belong inside the application
folder. Never select `C:\Program Files` itself. New builds reject NSIS destinations
whose final folder name is not `MediaSorter`, including silent `/D=` overrides.
They also refuse NSIS uninstallation from an unsafe shared folder.
For silent deployment, `/D=` must be the last argument and its absolute path
must remain unquoted, even with spaces, for example
`MediaSorter_X.Y.Z_x64-setup.exe /S /D=C:\Program Files\MediaSorter`.
New builds validate that original request before WebView2 or payload installation
and retain a valid silent target after the scope defaults initialize. Interactive
installations use the scope and directory pages to choose the final destination.
Before its maintenance page can run an older NSIS uninstaller, the new installer
checks registered locations and uninstall commands. An unsafe or unknown legacy
location requires a reviewed cleanup first; it is never silently migrated.

For a historical loose installation, close the app and back up its state using
[state and recovery](state-and-recovery.md). Identify its version and installed
file list before removing anything. Do not recursively delete Program Files or
run an old shared-root uninstaller without inspecting its removal scope. A new
installer cannot safely guess which shared files belong to that old release.
The version reset means a historical `1.0.x` installation may compare as newer
than the current baseline; inspect it before attempting a downgrade.

### Antivirus blocks versus SmartScreen

“The file contains a virus or potentially unwanted software” (including the
German “Die Datei enthält einen Virus oder möglicherweise unerwünschte Software”)
is an antivirus block. The SmartScreen **More info / Run anyway** instructions
do not resolve it. Preserve the blocked filename, detection name, antivirus
provider/version, release and SHA-256. Verify the downloaded ZIP against its
release checksums; do not execute a quarantined file or disable protection.

The portable and installed app share the frozen backend and native libraries.
An unsigned Python bundle is a plausible heuristic/reputation trigger, but this
does not establish a false positive or identify which file was detected. New
builds keep the existing directory bundle and disable automatic UPX compression
with `--noupx`; that removes a build-host-dependent binary transformation,
not a guarantee of antivirus acceptance.
[PyInstaller documents UPX behavior](https://pyinstaller.org/en/stable/usage.html#using-upx).

Report a verified official binary to the detecting vendor for review. Microsoft
provides its [sample submission portal](https://www.microsoft.com/en-us/wdsi/filesubmission).
G DATA provides [file/app review](https://www.gdata.de/help-en/general/GeneralInformation/submitFileAppURL/)
for its detections.
Do not submit personal media, databases or logs containing secrets. Publisher
signing is a separate improvement requiring enrollment; see
[signing](release-signing.md). A checksum or signature cannot prove that a file
is harmless. A changed package needs a new version and clean-host testing;
published assets remain immutable.

For an update, download and verify the newer installer from the official release;
close the running app and install it. Keep backups of media and application state.
Portable installations must keep the whole extracted bundle together.

### Automatic update checking

When **Check for updates** is enabled, the app checks the public stable GitHub
Release after settings load, then about every six hours while open. It sends
the application version as a User-Agent; media is not uploaded. Turning the
setting off stops new checks and hides cached banners; turning it back on checks
again. Dismissing a release hides that version only, so a later release can appear
in the same session. Offline/rate-limited checks do not block sorting.

The checker offers strictly newer stable versions, validates the release link,
and selects architecture-matching assets. Unknown/unsupported architectures use
the release page for manual selection. An equal latest/current version correctly
produces no banner. This is a notification/download-page feature; it does not
install updates automatically or repair an app that cannot start. Verify the
new package's checksum and signing state before manually updating.

For source development use [development setup](development.md#setup), including
Windows commands. [Headless/CLI setup](headless.md) is an advanced source mode,
not a prebuilt NAS package or a substitute for the desktop installation.
