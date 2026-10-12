"""Offline reverse geocoding from the bundled GeoNames extract.

``app/resources/geo`` holds the GeoNames ``cities1000`` places (CC BY 4.0) and
CLDR country names; ``scripts/build_geonames_extract.py`` builds them and
``SOURCE.json`` records their checksums. Nothing here touches the network.

Lookup projects every place onto the unit sphere once and answers a query with
one dot product over the table (≈171k rows, a fraction of a millisecond), so
there is no SciPy or tree index to ship. A place counts only within
``MAX_DISTANCE_KM``: a photo taken at sea or in a remote valley gets no town
rather than the nearest one 200 km away.

Coordinates are validated, not guessed at: they must be finite and inside the
WGS 84 ranges. ``(0, 0)`` is a valid position and is treated like any other,
which in practice means no place is close enough to tag.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import math
import threading
from dataclasses import dataclass
from importlib import resources
from typing import TYPE_CHECKING

import numpy as np

if TYPE_CHECKING:
    from numpy.typing import NDArray

#: Places farther than this from the photo are not used as its location.
MAX_DISTANCE_KM = 25.0
_EARTH_RADIUS_KM = 6371.0088
_GEO_PACKAGE = "app.resources.geo"


class GeoDataError(RuntimeError):
    """The bundled place extract is missing, corrupt or does not match SOURCE.json."""


@dataclass(frozen=True)
class Place:
    """The nearest known place to a coordinate."""

    name: str
    country_code: str
    distance_km: float

    def country_name(self, language: str) -> str:
        """The country's name in *language* (English as fallback, else the code)."""
        names = _table().countries.get(self.country_code, {})
        return names.get(language) or names.get("en") or self.country_code


def valid_coordinate(lat: float, lon: float) -> bool:
    """True for finite WGS 84 latitude/longitude pairs."""
    return (
        math.isfinite(lat)
        and math.isfinite(lon)
        and -90.0 <= lat <= 90.0
        and -180.0 <= lon <= 180.0
    )


def nearest_place(lat: float, lon: float, max_km: float = MAX_DISTANCE_KM) -> Place | None:
    """Return the nearest place within *max_km*, or ``None``.

    Raises :class:`ValueError` for an invalid coordinate and
    :class:`GeoDataError` when the bundled extract cannot be loaded.
    """
    if not valid_coordinate(lat, lon):
        raise ValueError("coordinate outside the WGS 84 range")
    table = _table()
    query = _unit_vector(math.radians(lat), math.radians(lon))
    cosines = table.vectors @ query
    index = int(np.argmax(cosines))
    # Chord length → great-circle distance; stable for nearby points, unlike acos.
    chord = float(np.linalg.norm(table.vectors[index].astype(np.float64) - query))
    distance = 2.0 * _EARTH_RADIUS_KM * math.asin(min(1.0, chord / 2.0))
    if distance > max_km:
        return None
    return Place(table.names[index], table.codes[index], distance)


# --------------------------------------------------------------------------- #
# Table loading                                                                #
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class _Table:
    vectors: NDArray[np.float32]
    names: tuple[str, ...]
    codes: tuple[str, ...]
    countries: dict[str, dict[str, str]]


_lock = threading.Lock()
_loaded: _Table | None = None


def _unit_vector(lat: float, lon: float) -> NDArray[np.float64]:
    cos_lat = math.cos(lat)
    return np.array([cos_lat * math.cos(lon), cos_lat * math.sin(lon), math.sin(lat)])


def _table() -> _Table:
    global _loaded
    table = _loaded
    if table is not None:
        return table
    with _lock:
        if _loaded is None:
            _loaded = _load()
        return _loaded


def _read_verified(name: str, expected: dict[str, str]) -> bytes:
    try:
        data = resources.files(_GEO_PACKAGE).joinpath(name).read_bytes()
    except (OSError, ModuleNotFoundError) as exc:
        raise GeoDataError(f"{name} is not bundled") from exc
    if hashlib.sha256(data).hexdigest() != expected.get(name):
        raise GeoDataError(f"{name} does not match SOURCE.json")
    return data


def _load() -> _Table:
    try:
        source = json.loads(resources.files(_GEO_PACKAGE).joinpath("SOURCE.json").read_bytes())
        expected = dict(source["sha256"])
    except (OSError, ModuleNotFoundError, ValueError, KeyError, TypeError) as exc:
        raise GeoDataError("SOURCE.json is missing or unreadable") from exc

    try:
        text = gzip.decompress(_read_verified("cities.tsv.gz", expected)).decode("utf-8")
        countries = json.loads(_read_verified("countries.json", expected).decode("utf-8"))
        lats: list[float] = []
        lons: list[float] = []
        names: list[str] = []
        codes: list[str] = []
        for line in text.splitlines():
            lat, lon, name, code = line.split("\t")
            lats.append(float(lat))
            lons.append(float(lon))
            names.append(name)
            codes.append(code)
    except (OSError, ValueError, UnicodeDecodeError) as exc:
        raise GeoDataError("the place extract is corrupt") from exc
    if not names:
        raise GeoDataError("the place extract is empty")

    lat_r = np.radians(np.asarray(lats))
    lon_r = np.radians(np.asarray(lons))
    cos_lat = np.cos(lat_r)
    vectors = np.stack(
        [cos_lat * np.cos(lon_r), cos_lat * np.sin(lon_r), np.sin(lat_r)], axis=1
    ).astype(np.float32)
    vectors.setflags(write=False)
    return _Table(vectors, tuple(names), tuple(codes), countries)
