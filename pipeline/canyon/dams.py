"""Flag river-profile samples beside mapped dams.

OS Open Rivers knows about lakes and river outlets but does not distinguish a
natural loch outlet from a dam. OpenStreetMap does: this module downloads the
small set of Scottish features tagged ``waterway=dam`` or ``man_made=dam``,
buffers their actual point/line geometry, and records the affected sample runs
in profiles.json. The browser can then hide dam spillways without deleting them
from the dataset.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import urllib.parse
import urllib.request

import numpy as np
from pyproj import Transformer
from shapely import intersects_xy
from shapely.geometry import LineString, Point
from shapely.ops import transform, unary_union

from . import payload

OVERPASS = (
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
)
# OSM relation 58446 is Scotland; Overpass area IDs add 3,600,000,000.
QUERY = """[out:json][timeout:180];
area(3600058446)->.scotland;
(
  node["waterway"="dam"](area.scotland);
  way["waterway"="dam"](area.scotland);
  node["man_made"="dam"](area.scotland);
  way["man_made"="dam"](area.scotland);
);
out geom;
"""


def fetch(cache: Path, refresh: bool = False) -> dict:
    if cache.exists() and not refresh:
        return json.loads(cache.read_text())
    body = urllib.parse.urlencode({"data": QUERY}).encode()
    error: Exception | None = None
    for endpoint in OVERPASS:
        try:
            req = urllib.request.Request(endpoint, data=body, headers={
                "Content-Type": "application/x-www-form-urlencoded",
                "User-Agent": "canyon-finder/1.0",
            })
            with urllib.request.urlopen(req, timeout=240) as response:
                doc = json.load(response)
            cache.parent.mkdir(parents=True, exist_ok=True)
            cache.write_text(json.dumps(doc, separators=(",", ":")))
            print(f"fetched {len(doc.get('elements', [])):,} mapped dams")
            return doc
        except Exception as exc:
            error = exc
            print(f"  {endpoint}: {exc}")
    raise SystemExit(f"could not fetch OSM dams: {error}")


def geometries(doc: dict, min_length: float = 0):
    """Unique OSM dam lines in BNG, optionally limited by crest length.

    Small weirs and intake structures are often tagged as dams too, but their
    downstream burns remain perfectly useful. Crest length is a simple proxy
    for the large embankments whose DEM profile creates a fake canyon.
    """
    seen: set[tuple[str, int]] = set()
    to_bng = Transformer.from_crs(4326, 27700, always_xy=True)
    for element in doc.get("elements", []):
        key = (element.get("type", ""), int(element.get("id", 0)))
        if key in seen:
            continue
        seen.add(key)
        if element.get("type") == "node":
            geom = Point(float(element["lon"]), float(element["lat"]))
        else:
            coords = [(float(p["lon"]), float(p["lat"]))
                      for p in element.get("geometry", [])]
            if len(coords) < 2:
                continue
            geom = LineString(coords)
        geom = transform(to_bng.transform, geom)
        if geom.length >= min_length:
            yield geom


def true_runs(mask: np.ndarray) -> list[list[int]]:
    """Inclusive [start, end] runs from a boolean sample mask."""
    at = np.flatnonzero(mask)
    if not len(at):
        return []
    breaks = np.flatnonzero(np.diff(at) > 1)
    starts = np.concatenate(([at[0]], at[breaks + 1]))
    ends = np.concatenate((at[breaks], [at[-1]]))
    return [[int(a), int(b)] for a, b in zip(starts, ends)]


def flag(out: Path, doc: dict, distance: float,
         min_length: float = 100) -> tuple[int, int]:
    p = payload.load(out)
    dams = list(geometries(doc, min_length))
    if not dams:
        raise SystemExit("OSM response contained no usable dam geometry")
    exclusion = unary_union(dams).buffer(distance)
    to_bng = Transformer.from_crs(4326, 27700, always_xy=True)

    affected_chains = affected_samples = 0
    for chain in p.meta["chains"]:
        chain.pop("dams", None)
        lon, lat = payload.chain_lonlat(chain, p.dlon, p.dlat)
        x, y = to_bng.transform(lon, lat)
        mask = intersects_xy(exclusion, np.asarray(x), np.asarray(y))
        runs = true_runs(mask)
        if runs:
            chain["dams"] = runs
            affected_chains += 1
            affected_samples += int(mask.sum())

    # Match payload.save's formatting so this post-process does not rewrite the
    # whole artifact differently merely to add the dam runs.
    (out / "profiles.json").write_text(json.dumps(p.meta))
    return affected_chains, affected_samples


def main() -> None:
    root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=root / "web" / "public" / "data")
    parser.add_argument("--raw", type=Path, default=root / "data" / "raw")
    parser.add_argument("--distance", type=float, default=150,
                        help="metres around dam geometry to flag (default 150)")
    parser.add_argument("--min-length", type=float, default=100,
                        help="minimum mapped dam crest length in metres (default 100)")
    parser.add_argument("--refresh", action="store_true",
                        help="re-fetch dam geometry from OpenStreetMap")
    args = parser.parse_args()

    doc = fetch(args.raw / "osm_dams.json", args.refresh)
    chains, samples = flag(args.out, doc, args.distance, args.min_length)
    print(f"flagged {samples:,} samples on {chains:,} chains within "
          f"{args.distance:g} m of a mapped dam at least "
          f"{args.min_length:g} m long")


if __name__ == "__main__":
    main()
