"""Replace Terrain 50 profiles with LiDAR ones wherever LiDAR exists.

Coverage is patchy and weighted to the Central Belt and Borders, so this runs per
region rather than nationally: pick a bbox, and every chain inside it that the
LiDAR covers is re-profiled at 0.5-2 m and flagged in the payload.
"""

from __future__ import annotations

import argparse
import time
from pathlib import Path

import numpy as np
import rasterio
from pyproj import Transformer

from . import payload
from .build import (CONFINE_RADIUS, MIN_SCREEN_GRADIENT, SCALES, condition,
                    max_gradient_at_scale)
from .features import confinement
from .lidar import GDAL_ENV, LidarSampler, build_index
from .payload import chain_lonlat


def refine(out: Path, work: Path, bbox: tuple[float, float, float, float],
           radius: float, limit: int | None) -> None:
    with rasterio.Env(**GDAL_ENV):
        _refine(out, work, bbox, radius, limit)


def _refine(out: Path, work: Path, bbox: tuple[float, float, float, float],
            radius: float, limit: int | None) -> None:
    t0 = time.time()
    print("building LiDAR tile index ...", flush=True)
    tiles = build_index(work / "lidar_tiles.json")
    print(f"  {len(tiles)} DTM tiles, finest {min(t.res for t in tiles)} m")

    pay = payload.load(out)
    meta, z, conf = pay.meta, pay.z, pay.conf
    to_bng = Transformer.from_crs(4326, 27700, always_xy=True)
    sampler = LidarSampler(tiles, radius=radius)

    minx, miny, maxx, maxy = bbox
    done = improved = 0
    for c in meta["chains"]:
        lon, lat = chain_lonlat(c, pay.dlon, pay.dlat)
        x, y = to_bng.transform(lon, lat)
        x, y = np.asarray(x), np.asarray(y)
        if x.max() < minx or x.min() > maxx or y.max() < miny or y.min() > maxy:
            continue
        if not sampler.tile_for(float(x[len(x) // 2]), float(y[len(y) // 2])):
            continue

        zl, used = sampler.sample(x, y)
        ok = np.isfinite(zl)
        done += 1
        if ok.sum() < len(zl) * 0.9:
            continue
        if not ok.all():
            idx = np.arange(len(zl))
            zl = np.interp(idx, idx[ok], zl[ok])
        res = min(sampler.by_key[k].res for k in used) if used else 0
        zc = condition(zl.astype(np.float32))
        s = slice(c["o"], c["o"] + c["n"])
        z[s] = np.round(zc * 10).astype(np.int16)

        # Confinement has to be re-measured too, or a refined chain keeps a
        # gorge depth read off the 50 m grid that flattened the gorge. Banks are
        # ground level, so they are point samples, not channel-floor minima.
        cf = confinement(lambda bx, by: sampler.sample(bx, by, radius=0.0)[0],
                         x, y, zc, (CONFINE_RADIUS,))[CONFINE_RADIUS]
        conf[s] = np.where(np.isfinite(cf), np.clip(np.round(cf), 0, 255),
                           conf[s]).astype(np.uint8)

        c["screen"] = [round(max_gradient_at_scale(zc, sc), 4) for sc in SCALES]
        c["top"] = round(float(zc[0]), 1)
        c["bottom"] = round(float(zc[-1]), 1)
        c["dem"] = f"{res:g} m LiDAR"
        improved += 1
        if done % 25 == 0:
            print(f"  {done} chains checked, {improved} re-profiled "
                  f"({time.time() - t0:.0f}s)", flush=True)
        if limit and improved >= limit:
            break

    sampler.close()
    # Chains that lost all steepness under a truer DEM stay in the payload; the
    # prescreen in the browser filters them out at query time.
    meta["dem"] = meta.get("dem", "") + " + Scottish public sector LiDAR where available"
    meta["lidar_refined"] = int(sum(1 for c in meta["chains"] if c.get("dem")))
    payload.save(out, pay)
    kept = sum(1 for c in meta["chains"] if max(c["screen"]) >= MIN_SCREEN_GRADIENT)
    print(f"re-profiled {improved} chains in {time.time() - t0:.0f}s "
          f"({kept} of {len(meta['chains'])} still above the screen floor)")


def main() -> None:
    root = Path(__file__).resolve().parents[2]
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--out", type=Path, default=root / "web" / "public" / "data")
    p.add_argument("--work", type=Path, default=root / "data" / "work")
    p.add_argument("--bbox", type=float, nargs=4, required=True,
                   metavar=("MINX", "MINY", "MAXX", "MAXY"), help="BNG extent to refine")
    p.add_argument("--radius", type=float, default=12.0,
                   help="channel-floor search radius in metres (default 12)")
    p.add_argument("--limit", type=int, help="stop after this many chains")
    a = p.parse_args()
    refine(a.out, a.work, tuple(a.bbox), a.radius, a.limit)


if __name__ == "__main__":
    main()
