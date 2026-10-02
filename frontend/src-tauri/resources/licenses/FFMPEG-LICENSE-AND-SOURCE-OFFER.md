# ffmpeg — licence and written offer for source

MediaSorter is MIT-licensed, and it **bundles ffmpeg and ffprobe binaries that
are licensed GPL-3.0-or-later**. The GPL covers those binaries, not this
application's own source, and the full licence text ships beside this file as
`COPYING.GPLv3`.

## What is bundled

Manifest version `2026-08-13.1` — the single record of what a
release fetches, kept at `scripts/ffmpeg-sources.json` in the source repository.

| Target | Binaries | Upstream version | Licence | Fetched from |
|---|---|---|---|---|
| `darwin-arm64` | ffmpeg | 7.1 | GPL-3.0-or-later | https://github.com/descriptinc/ffmpeg-ffprobe-static/releases/download/b7.1.0-rc.1/ffmpeg-darwin-arm64 |
| `darwin-arm64` | ffprobe | 7.1 | GPL-3.0-or-later | https://github.com/descriptinc/ffmpeg-ffprobe-static/releases/download/b7.1.0-rc.1/ffprobe-darwin-arm64 |
| `darwin-x86_64` | ffmpeg | 7.1.1 | GPL-3.0-or-later | https://evermeet.cx/ffmpeg/ffmpeg-7.1.1.zip |
| `darwin-x86_64` | ffprobe | 7.1.1 | GPL-3.0-or-later | https://evermeet.cx/ffmpeg/ffprobe-7.1.1.zip |
| `linux-arm64` | ffmpeg, ffprobe | N-125365-g9a01c1cb6a | GPL-3.0-or-later | https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-06-30-13-34/ffmpeg-N-125365-g9a01c1cb6a-linuxarm64-gpl.tar.xz |
| `linux-x86_64` | ffmpeg, ffprobe | N-125365-g9a01c1cb6a | GPL-3.0-or-later | https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-06-30-13-34/ffmpeg-N-125365-g9a01c1cb6a-linux64-gpl.tar.xz |
| `windows-x86_64` | ffmpeg.exe, ffprobe.exe | N-125365-g9a01c1cb6a | GPL-3.0-or-later | https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-06-30-13-34/ffmpeg-N-125365-g9a01c1cb6a-win64-gpl.zip |

Each download's SHA-256 is pinned in that manifest and verified at fetch time,
so the bytes in a release are the bytes recorded there.

## Written offer

Section 6 of the GPL requires that anyone receiving these binaries can obtain
their Corresponding Source.

The binaries are redistributed unmodified from the upstream release named above.
Their complete corresponding source is the ffmpeg source for that version,
published by the FFmpeg project at <https://ffmpeg.org/download.html> and
archived per release at <https://ffmpeg.org/releases/>.

**For a period of three years from the date you received this software**, the
distributor will also provide the complete corresponding source of these
binaries, on a physical medium or by download, for no more than the cost of
performing the distribution. Request it by opening an issue at
<https://github.com/fileworks/media-sorter/issues> titled "ffmpeg source
request", naming the MediaSorter version you received.

## Removing ffmpeg

Nothing in this offer is conditional on using the bundled binaries. MediaSorter
runs without them; video conversion and video frame sampling are the features
that need them.
