#!/usr/bin/env python3
"""Build the offline place-name extract the backend uses for GPS location tags.

Source: GeoNames ``cities1000`` (populated places with at least 1,000 people),
licensed CC BY 4.0 by GeoNames (https://www.geonames.org/). Country names come
from the Unicode CLDR data shipped with Babel (Unicode License v3).

City sections, historical, abandoned and destroyed places are left out, so a
photo is tagged with its town rather than a neighbourhood. The extract keeps
only what lookup needs — latitude, longitude, place name and
ISO country code — so it is a few megabytes instead of the 26 MB CSV the
retired ``reverse_geocoder`` package carried. GeoNames publishes rolling dumps
without versions, so reproducibility comes from the committed extract and its
recorded SHA-256 in ``SOURCE.json``, not from re-running this script.

Usage (build-time only; needs network and ``babel``)::

    python scripts/build_geonames_extract.py [--ca-file certifi.pem]
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import gzip
import hashlib
import io
import json
import ssl
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "backend" / "app" / "resources" / "geo"
SOURCE_URL = "https://download.geonames.org/export/dump/cities1000.zip"
LOCALES = ("en", "de")
#: Feature codes that are not a town a photo was taken in: city sections
#: ("Tribeca" instead of "New York City"), historical, abandoned and destroyed places.
EXCLUDED_FEATURES = frozenset({"PPLX", "PPLH", "PPLQ", "PPLW", "PPLCH"})


def _download(url: str, ca_file: str | None) -> bytes:
    context = ssl.create_default_context(cafile=ca_file)
    request = urllib.request.Request(url, headers={"User-Agent": "MediaSorter extract builder"})
    with urllib.request.urlopen(request, timeout=120, context=context) as response:
        return response.read()


def _cities(archive: bytes) -> list[tuple[str, str, str, str]]:
    rows: list[tuple[str, str, str, str]] = []
    with zipfile.ZipFile(io.BytesIO(archive)) as bundle, bundle.open("cities1000.txt") as handle:
        text = io.TextIOWrapper(handle, encoding="utf-8", newline="")
        for record in csv.reader(text, delimiter="\t", quoting=csv.QUOTE_NONE):
            # geonameid, name, asciiname, alternatenames, latitude, longitude,
            # feature class, feature code, country code, …
            name, lat, lon, country = record[1], record[4], record[5], record[8]
            if not name or not country or record[7] in EXCLUDED_FEATURES:
                continue
            rows.append((f"{float(lat):.4f}", f"{float(lon):.4f}", name, country.upper()))
    rows.sort(key=lambda row: (row[3], row[2], row[0], row[1]))
    return rows


def _countries(codes: set[str]) -> dict[str, dict[str, str]]:
    from babel import Locale

    names = {locale: Locale.parse(locale).territories for locale in LOCALES}
    return {
        code: {locale: str(names[locale].get(code, code)) for locale in LOCALES}
        for code in sorted(codes)
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ca-file", default=None, help="CA bundle for HTTPS verification")
    args = parser.parse_args()

    rows = _cities(_download(SOURCE_URL, args.ca_file))
    OUT.mkdir(parents=True, exist_ok=True)
    buffer = io.StringIO()
    writer = csv.writer(
        buffer, delimiter="\t", lineterminator="\n", quoting=csv.QUOTE_NONE, escapechar="\\"
    )
    writer.writerows(rows)
    cities = OUT / "cities.tsv.gz"
    # mtime=0 keeps the gzip bytes deterministic for identical content.
    cities.write_bytes(gzip.compress(buffer.getvalue().encode("utf-8"), mtime=0))
    countries = OUT / "countries.json"
    countries.write_text(
        json.dumps(
            _countries({row[3] for row in rows}), ensure_ascii=False, indent=1, sort_keys=True
        )
        + "\n",
        encoding="utf-8",
        newline="\n",
    )
    source = {
        "dataset": "GeoNames cities1000",
        "excluded_feature_codes": sorted(EXCLUDED_FEATURES),
        "source_url": SOURCE_URL,
        "license": "CC BY 4.0",
        "attribution": "Place names: GeoNames (https://www.geonames.org/), CC BY 4.0",
        "country_names": "Unicode CLDR via Babel, Unicode License v3",
        "retrieved": dt.date.today().isoformat(),
        "places": len(rows),
        "sha256": {
            path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in (cities, countries)
        },
    }
    (OUT / "SOURCE.json").write_text(
        json.dumps(source, indent=2) + "\n", encoding="utf-8", newline="\n"
    )
    print(json.dumps(source, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
