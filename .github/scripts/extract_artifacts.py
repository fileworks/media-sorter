"""Extract digest-verified Actions archives, retaining each artifact's namespace."""

from __future__ import annotations

import argparse
import stat
import zipfile
from pathlib import Path, PurePosixPath


def extract(source: Path, destination: Path) -> None:
    """Accept one ZIP per artifact folder and refuse ambiguous or escaping paths."""
    folders = sorted(source.iterdir())
    if not folders or any(not folder.is_dir() or folder.is_symlink() for folder in folders):
        raise ValueError("Expected separate downloaded artifact directories")
    for folder in folders:
        archives = list(folder.iterdir())
        if len(archives) != 1 or archives[0].suffix != ".zip" or archives[0].is_symlink():
            raise ValueError(f"Expected one raw ZIP in {folder.name}")
        target = destination / folder.name
        if target.exists() or target.is_symlink():
            raise ValueError(f"Refusing to overwrite {target}")
        with zipfile.ZipFile(archives[0]) as archive:
            names: set[str] = set()
            for member in archive.infolist():
                # Validate the raw name before ZipInfo's Windows normalization.
                name = member.orig_filename
                path = PurePosixPath(name)
                if (
                    not name
                    or path.as_posix() == "."
                    or name.rstrip("/") != path.as_posix()
                    or path.is_absolute()
                    or ".." in path.parts
                    or "\\" in name
                    or ":" in name
                    or "\0" in name
                    or path.as_posix() in names
                    or stat.S_ISLNK(member.external_attr >> 16)
                ):
                    raise ValueError(f"Unsafe or duplicate archive entry: {name!r}")
                names.add(path.as_posix())
            archive.extractall(target)
        print(f"Extracted {folder.name}: {len(names)} entries")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    extract(args.source, args.destination)
