"""How much of the steep-reach shortlist sits inside LiDAR coverage.

Answers the question that decides the elevation strategy: can LiDAR be the
primary DEM, or only a refinement over a national Terrain 50 baseline?
"""

from __future__ import annotations

import argparse
from collections import Counter
from pathlib import Path

import numpy as np
from pyproj import Transformer
from shapely.geometry import Point

from . import payload
from .build import SCALES
from .lidar import LidarSampler, build_index
from .lidarmap import coverage_polygon
from .payload import chain_lonlat


def main() -> None:
    root = Path(__file__).resolve().parents[2]
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--out", type=Path, default=root / "web" / "public" / "data")
    p.add_argument("--raw", type=Path, default=root / "data" / "raw")
    p.add_argument("--work", type=Path, default=root / "data" / "work")
    p.add_argument("--gradient", type=float, default=0.12,
                   help="steepness that counts as a candidate (default 0.12)")
    p.add_argument("--scale", type=int, default=400, choices=SCALES,
                   help="window length the gradient is measured over")
    a = p.parse_args()

    tiles = build_index(a.work / "lidar_tiles.json")
    sampler = LidarSampler(tiles)
    coverage = coverage_polygon(a.work / "lidar_coverage.png", a.raw)
    pay = payload.load(a.out)
    meta = pay.meta
    to_bng = Transformer.from_crs(4326, 27700, always_xy=True)
    si = SCALES.index(a.scale)

    covered = Counter()
    steep = 0
    for c in meta["chains"]:
        if c["screen"][si] < a.gradient:
            continue
        steep += 1
        lon, lat = chain_lonlat(c, pay.dlon, pay.dlat)
        x, y = to_bng.transform(lon, lat)
        x, y = np.asarray(x), np.asarray(y)
        sample = np.linspace(0, len(x) - 1, min(len(x), 12)).astype(int)
        valid = [coverage.covers(Point(float(x[i]), float(y[i]))) for i in sample]
        frac = sum(valid) / len(valid)
        # The WMS says whether elevation exists; the tile index still says at
        # what resolution, without touching the raster itself.
        hits = [sampler.tile_for(float(x[i]), float(y[i]))
                for i, ok in zip(sample, valid) if ok]
        res = min((h.res for h in hits if h), default=None)
        if frac >= 0.9:
            covered[f"full, {res:g} m" if res is not None else "full, other"] += 1
        elif frac > 0:
            covered["partial"] += 1
        else:
            covered["none"] += 1

    print(f"watercourses with a {a.scale} m window at or above "
          f"{a.gradient * 100:.0f}%: {steep:,}")
    for k, n in covered.most_common():
        print(f"  LiDAR {k:16} {n:6,}  {n / steep * 100:5.1f}%")


if __name__ == "__main__":
    main()
