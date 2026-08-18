"""Where the LiDAR actually is, as an outline the map can draw.

Do not infer coverage from DTM file footprints: the old Highland phase files are
mostly nodata, with data confined to the glens they were flown for. The Scottish
Remote Sensing Portal publishes the real aggregate coverage as a WMS layer. One
national 250 m image from that layer is a 200 KB binary alpha mask; this traces
it into the GeoJSON used by the web app and caches the image for later runs.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import urllib.parse
import urllib.request
import warnings

import numpy as np
import rasterio
from pyproj import Transformer
from rasterio.features import shapes as raster_shapes
from shapely.geometry import MultiPolygon, mapping, shape
from shapely.ops import transform, unary_union

from .boundary import scotland_polygon

CELL = 250.0
BBOX = (0.0, 500_000.0, 500_000.0, 1_250_000.0)  # all Scotland, BNG
WMS = "https://ows.remotesensing.data.gov.scot/geoserver/scotland/wms"
LAYER = "scotland:lidar-aggregate"


def coverage_grid(cache: Path, refresh: bool = False) -> np.ndarray:
    """Actual LiDAR coverage, north-up at 250 m, from the portal's WMS."""
    width = round((BBOX[2] - BBOX[0]) / CELL)
    height = round((BBOX[3] - BBOX[1]) / CELL)
    if refresh or not cache.exists():
        query = urllib.parse.urlencode({
            "service": "WMS", "request": "GetMap", "version": "1.1.1",
            "layers": LAYER, "styles": "", "format": "image/png",
            "transparent": "true", "srs": "EPSG:27700",
            "bbox": ",".join(f"{v:g}" for v in BBOX),
            "width": width, "height": height,
        })
        req = urllib.request.Request(f"{WMS}?{query}", headers={
            "User-Agent": "canyon-finder/1.0",
        })
        with urllib.request.urlopen(req, timeout=120) as response:
            raw = response.read()
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_bytes(raw)
        print(f"fetched {len(raw) / 1000:.0f} KB coverage image")

    # A WMS PNG has no embedded georeferencing; BBOX supplies it below.
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", rasterio.errors.NotGeoreferencedWarning)
        with rasterio.open(cache) as src:
            if src.count != 4 or (src.width, src.height) != (width, height):
                raise SystemExit(f"unexpected LiDAR coverage image: "
                                 f"{src.width}x{src.height}, {src.count} bands")
            return src.read(4) > 0  # alpha: transparent means no LiDAR


def coverage_polygon(cache: Path, raw: Path, refresh: bool = False,
                     simplify: float = 150):
    """Portal coverage as a BNG Polygon/MultiPolygon, clipped to Scotland."""
    grid = coverage_grid(cache, refresh)
    affine = (CELL, 0.0, BBOX[0], 0.0, -CELL, BBOX[3])
    geoms = [shape(g) for g, value in raster_shapes(
        grid.astype(np.uint8), transform=affine) if int(value) == 1]
    merged = unary_union(geoms).simplify(simplify)
    return merged.intersection(scotland_polygon(raw))


def rounded(value):
    """Round every coordinate in a nested GeoJSON coordinate array."""
    if value and isinstance(value[0], (int, float)):
        return [round(value[0], 5), round(value[1], 5)]
    return [rounded(v) for v in value]


def main() -> None:
    root = Path(__file__).resolve().parents[2]
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--out", type=Path, default=root / "web" / "public" / "data")
    p.add_argument("--raw", type=Path, default=root / "data" / "raw")
    p.add_argument("--work", type=Path, default=root / "data" / "work")
    p.add_argument("--simplify", type=float, default=150,
                   help="metres of tolerance when simplifying the outline")
    p.add_argument("--refresh", action="store_true",
                   help="re-fetch the portal coverage image")
    a = p.parse_args()

    covered = coverage_polygon(
        a.work / "lidar_coverage.png", a.raw, a.refresh, a.simplify)
    parts = list(covered.geoms) if hasattr(covered, "geoms") else [covered]
    covered = MultiPolygon(parts)
    print(f"coverage in Scotland: {covered.area / 1e6:,.0f} km2, "
          f"{len(parts)} parts")

    to_wgs = Transformer.from_crs(27700, 4326, always_xy=True)
    geom = mapping(transform(to_wgs.transform, covered))
    geom["coordinates"] = rounded(geom["coordinates"])

    a.out.mkdir(parents=True, exist_ok=True)
    path = a.out / "lidar.json"
    path.write_text(json.dumps({
        "type": "FeatureCollection",
        "features": [{"type": "Feature", "properties": {}, "geometry": geom}],
    }))
    print(f"wrote {path.stat().st_size / 1e6:.2f} MB -> {path}")


if __name__ == "__main__":
    main()
