"""Where the LiDAR actually is, as an outline the map can draw.

The tile index the refiner samples from is footprints on the OS grid; this
merges them into one MultiPolygon, clipped to Scotland and simplified, so the
web app can show which regions carry high-resolution elevation. Runs from the
cached index alone — no S3 access — after any refine/coverage run has built it.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from pyproj import Transformer
from shapely.geometry import box, mapping
from shapely.ops import transform, unary_union

from .boundary import scotland_polygon
from .lidar import build_index


def main() -> None:
    root = Path(__file__).resolve().parents[2]
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--out", type=Path, default=root / "web" / "public" / "data")
    p.add_argument("--raw", type=Path, default=root / "data" / "raw")
    p.add_argument("--work", type=Path, default=root / "data" / "work")
    p.add_argument("--simplify", type=float, default=300,
                   help="metres of tolerance when simplifying the outline")
    a = p.parse_args()

    tiles = build_index(a.work / "lidar_tiles.json")
    print(f"{len(tiles)} tiles in the index")

    # Tile footprints are axis-aligned squares, so the union is cheap and the
    # result collapses to the coverage outline.
    merged = unary_union(
        [box(t.minx, t.miny, t.minx + t.size, t.miny + t.size) for t in tiles])
    clipped = merged.intersection(scotland_polygon(a.raw))
    simple = clipped.simplify(a.simplify)
    print(f"coverage {merged.area / 1e6:,.0f} km2, "
          f"{len(mapping(simple)['coordinates'])} parts after simplifying")

    # Simplify in BNG where metres are metres, quantise only after projecting:
    # ~1 m precision is plenty for a country-scale outline.
    to_wgs = Transformer.from_crs(27700, 4326, always_xy=True)
    geom = mapping(transform(to_wgs.transform, simple))
    geom["coordinates"] = [
        [[(round(x, 5), round(y, 5)) for x, y in ring] for ring in poly]
        for poly in geom["coordinates"]
    ]

    a.out.mkdir(parents=True, exist_ok=True)
    (a.out / "lidar.json").write_text(json.dumps({
        "type": "FeatureCollection",
        "features": [{"type": "Feature", "properties": {}, "geometry": geom}],
    }))
    print(f"wrote {(a.out / 'lidar.json').stat().st_size / 1e6:.2f} MB "
          f"-> {a.out / 'lidar.json'}")


if __name__ == "__main__":
    main()
