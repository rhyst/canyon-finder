"""Replace Terrain 50 profiles with LiDAR ones wherever LiDAR exists.

Coverage is patchy and weighted to the Central Belt and Borders, so this runs per
region rather than nationally: pick a bbox, and every chain inside it that the
LiDAR covers is re-profiled at 0.5-2 m and flagged in the payload.
"""

from __future__ import annotations

import argparse
import json
import struct
import time
from pathlib import Path

import numpy as np
import rasterio
from pyproj import Transformer

from .build import MIN_SCREEN_GRADIENT, SCALES, condition, max_gradient_at_scale
from .lidar import GDAL_ENV, LidarSampler, build_index


def load_payload(out: Path):
    meta = json.loads((out / "profiles.json").read_text())
    raw = bytearray((out / "profiles.bin").read_bytes())
    magic, total, n_chains, spacing = struct.unpack_from("<4sIII", raw, 0)
    assert magic == b"CNY3", magic
    off = 16
    z = np.frombuffer(bytes(raw[off:off + total * 2]), np.int16).copy()
    off += total * 2
    up = np.frombuffer(bytes(raw[off:off + total * 2]), np.uint16).copy()
    off += total * 2
    dlon = np.frombuffer(bytes(raw[off:off + total * 2]), np.int16).copy()
    dlat = np.frombuffer(bytes(raw[off + total * 2:off + total * 4]), np.int16).copy()
    off += total * 4
    conf = np.frombuffer(bytes(raw[off:off + total]), np.uint8).copy()
    return meta, z, up, conf, dlon, dlat, total, float(spacing)


def chain_lonlat(c: dict, dlon: np.ndarray, dlat: np.ndarray):
    s = slice(c["o"], c["o"] + c["n"])
    lon = (c["lon0"] + np.cumsum(dlon[s].astype(np.int64)) - int(dlon[s][0])) / 1e7
    lat = (c["lat0"] + np.cumsum(dlat[s].astype(np.int64)) - int(dlat[s][0])) / 1e7
    return lon, lat


def save_payload(out: Path, meta, z, up, conf, dlon, dlat, total, spacing) -> None:
    with (out / "profiles.bin").open("wb") as f:
        f.write(struct.pack("<4sIII", b"CNY3", total, len(meta["chains"]), int(spacing)))
        f.write(z.astype(np.int16).tobytes())
        f.write(up.astype(np.uint16).tobytes())
        f.write(dlon.astype(np.int16).tobytes())
        f.write(dlat.astype(np.int16).tobytes())
        f.write(conf.astype(np.uint8).tobytes())
    (out / "profiles.json").write_text(json.dumps(meta))


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

    meta, z, up, conf, dlon, dlat, total, spacing = load_payload(out)
    to_bng = Transformer.from_crs(4326, 27700, always_xy=True)
    sampler = LidarSampler(tiles, radius=radius)

    minx, miny, maxx, maxy = bbox
    done = improved = 0
    for c in meta["chains"]:
        lon, lat = chain_lonlat(c, dlon, dlat)
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
    save_payload(out, meta, z, up, conf, dlon, dlat, total, spacing)
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
