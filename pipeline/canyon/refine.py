"""Replace Terrain 50 profiles with LiDAR ones wherever LiDAR exists.

Scottish coverage is patchy and weighted to the Central Belt and Borders, so it
runs per region: pick a bbox, and every chain inside it that the LiDAR covers is
re-profiled at 0.5-2 m and flagged in the payload. England and Wales have
national composites, so that source defaults to everything. Chains already
re-profiled are skipped and progress is saved as it goes, so an interrupted run
resumes.
"""

from __future__ import annotations

import argparse
import time
from pathlib import Path

import numpy as np
import rasterio
from pyproj import Transformer

from . import payload
from .build import (BBOX, CONFINE_RADIUS, MIN_SCREEN_GRADIENT, SCALES, condition,
                    max_gradient_at_scale)
from .features import confinement
from .lidar import GDAL_ENV, LidarSampler, build_index
from . import lidar_ew
from .lidar_ew import SIZE, TileSampler
from .payload import chain_lonlat

SOURCES = {
    "scotland": "Scottish public sector LiDAR",
    "england-wales": "Environment Agency and Welsh Government LiDAR",
}
LOOKAHEAD = 24  # chains whose tiles are fetched ahead of the one being sampled
SAVE_EVERY = 200


def ordered(todo: list, sampler: TileSampler) -> list:
    """Wales first, then England's steepest country.

    Wales reads fast and England downloads slowly, so an interrupted run should
    have done the most useful part. Within that, neighbouring chains share
    tiles, so they are walked in spatial order.
    """
    BLOCK = 4 * SIZE
    mid = lambda t: (float(t[1][len(t[1]) // 2]), float(t[2][len(t[2]) // 2]))
    steep: dict[tuple[int, int], int] = {}
    for t in todo:
        x, y = mid(t)
        cell = (int(x // BLOCK), int(y // BLOCK))
        steep[cell] = steep.get(cell, 0) + (max(t[0]["screen"]) >= 0.2)

    def key(t):
        x, y = mid(t)
        cell = (int(x // BLOCK), int(y // BLOCK))
        return (not sampler.in_wales(x, y), -steep[cell], cell, int(y // SIZE),
                int(x // SIZE))
    return sorted(todo, key=key)


def refine(out: Path, work: Path, raw: Path, source: str,
           bbox: tuple[float, float, float, float], radius: float,
           limit: int | None, min_screen: float) -> None:
    with rasterio.Env(**GDAL_ENV):
        _refine(out, work, raw, source, bbox, radius, limit, min_screen)


def _refine(out: Path, work: Path, raw: Path, source: str,
            bbox: tuple[float, float, float, float], radius: float,
            limit: int | None, min_screen: float) -> None:
    t0 = time.time()
    if source == "scotland":
        print("building LiDAR tile index ...", flush=True)
        tiles = build_index(work / "lidar_tiles.json")
        print(f"  {len(tiles)} DTM tiles, finest {min(t.res for t in tiles)} m")
        sampler = LidarSampler(tiles, radius=radius)
    else:
        sampler = TileSampler(raw, radius=radius)

    pay = payload.load(out)
    meta, z, conf = pay.meta, pay.z, pay.conf
    to_bng = Transformer.from_crs(4326, 27700, always_xy=True)

    minx, miny, maxx, maxy = bbox
    todo: list[tuple[dict, np.ndarray, np.ndarray]] = []
    for c in meta["chains"]:
        if c.get("dem") or max(c["screen"]) < min_screen:
            continue
        lon, lat = chain_lonlat(c, pay.dlon, pay.dlat)
        x, y = to_bng.transform(lon, lat)
        x, y = np.asarray(x), np.asarray(y)
        if x.max() < minx or x.min() > maxx or y.max() < miny or y.min() > maxy:
            continue
        if not sampler.tile_for(float(x[len(x) // 2]), float(y[len(y) // 2])):
            continue
        todo.append((c, x, y))
    if source == "england-wales":
        todo = ordered(todo, sampler)
    print(f"{len(todo)} chains to check", flush=True)

    def save() -> None:
        label = f"{SOURCES[source]} where available"
        if label not in meta.get("dem", ""):
            meta["dem"] = meta.get("dem", "") + f" + {label}"
        meta["lidar_refined"] = int(sum(1 for c in meta["chains"] if c.get("dem")))
        payload.save(out, pay)

    done = improved = 0
    told = time.time()
    for k, (c, x, y) in enumerate(todo):
        if time.time() - told > 60:
            told = time.time()
            print(f"  {done} chains checked, {improved} re-profiled "
                  f"({time.time() - t0:.0f}s)", flush=True)
        for _, ax, ay in todo[k: k + LOOKAHEAD]:
            sampler.prefetch(ax, ay)
        zl, used = sampler.sample(x, y)
        ok = np.isfinite(zl)
        done += 1
        if ok.sum() < len(zl) * 0.9:
            continue
        if not ok.all():
            idx = np.arange(len(zl))
            zl = np.interp(idx, idx[ok], zl[ok])
        res = sampler.res_of(used)
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
        if improved % SAVE_EVERY == 0:
            save()
        if limit and improved >= limit:
            break

    sampler.close()
    # Chains that lost all steepness under a truer DEM stay in the payload; the
    # prescreen in the browser filters them out at query time.
    save()
    if lidar_ew.failed:
        print(f"  {len(lidar_ew.failed)} tiles could not be downloaded; re-run to retry")
    kept = sum(1 for c in meta["chains"] if max(c["screen"]) >= MIN_SCREEN_GRADIENT)
    print(f"re-profiled {improved} chains in {time.time() - t0:.0f}s "
          f"({kept} of {len(meta['chains'])} still above the screen floor)")


def main() -> None:
    root = Path(__file__).resolve().parents[2]
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--out", type=Path, default=root / "web" / "public" / "data")
    p.add_argument("--work", type=Path, default=root / "data" / "work")
    p.add_argument("--raw", type=Path, default=root / "data" / "raw")
    p.add_argument("--source", choices=sorted(SOURCES), default="scotland")
    p.add_argument("--bbox", type=float, nargs=4,
                   metavar=("MINX", "MINY", "MAXX", "MAXY"),
                   help="BNG extent to refine (required for scotland)")
    p.add_argument("--radius", type=float, default=12.0,
                   help="channel-floor search radius in metres (default 12)")
    p.add_argument("--min-screen", type=float, default=0.0,
                   help="skip chains whose steepest window is below this gradient")
    p.add_argument("--limit", type=int, help="stop after this many chains")
    a = p.parse_args()
    if a.bbox is None and a.source == "scotland":
        p.error("--bbox is required for --source scotland")
    refine(a.out, a.work, a.raw, a.source, tuple(a.bbox or BBOX), a.radius,
           a.limit, a.min_screen)


if __name__ == "__main__":
    main()
