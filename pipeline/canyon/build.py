"""Compile watercourse + elevation data into a binary the browser can search live.

Output (data/out/):
  profiles.bin   packed per-chain arrays: elevation, geometry, catchment
  profiles.json  chain index + prescreen metadata

The browser does the gradient/length search itself, so every slider move is
instant and no query hits a server.
"""

from __future__ import annotations

import argparse
import time
from pathlib import Path

import numpy as np
from pyproj import Transformer
from shapely.geometry import Point

from . import payload, rivers
from .boundary import scotland
from .dem import Terrain50
from .features import confinement

SPACING = 25.0  # metres between profile samples
# Chain-level prescreen: max gradient found over each window length (metres).
SCALES = [100, 200, 400, 800, 1600, 3200]
# Chains with no window at or above this gradient are dropped from the payload.
MIN_SCREEN_GRADIENT = 0.04
MIN_CHAIN_LENGTH = 100.0
# Offset at which valley-side rise is recorded per sample.
CONFINE_RADIUS = 100.0

# Scotland, BNG. The bbox reaches into northern England; chains whose midpoint
# falls outside the Scotland polygon are dropped.
BBOX = (0.0, 520_000.0, 500_000.0, 1_300_000.0)
SQUARES = """HO HP HT HU HW HX HY HZ NA NB NC ND NE NF NG NH NJ NK NL NM NN NO
             NR NS NT NU NW NX NY NZ""".split()


def max_gradient_at_scale(z: np.ndarray, window: int) -> float:
    """Largest drop/length over any window of `window` metres, as a fraction."""
    k = max(1, int(round(window / SPACING)))
    if len(z) <= k:
        k = len(z) - 1
        if k < 1:
            return 0.0
    drop = z[:-k] - z[k:]
    return float(drop.max() / (k * SPACING)) if drop.size else 0.0


def condition(z: np.ndarray) -> np.ndarray:
    """Force elevation to be non-increasing downstream.

    A 50m DEM sampled along a stream produces small uphill bumps that are DEM
    error, not real. Removing them stops those bumps eating into measured drop.
    """
    return np.minimum.accumulate(z)


def build(raw: Path, out: Path, gpkg: Path, bbox: tuple[float, ...] = BBOX) -> None:
    t0 = time.time()
    print("loading OS Terrain 50 ...", flush=True)
    dem = Terrain50.load(raw / "terr50", set(SQUARES), cache=raw.parent / "work" / "terr50.npz")
    print(f"  {len(dem.tiles)} tiles  ({time.time() - t0:.0f}s)", flush=True)
    scot = scotland(raw)

    print("loading OS Open Rivers ...", flush=True)
    links = rivers.load_links(gpkg, bbox)
    print(f"  {len(links)} links, {sum(l.length for l in links) / 1000:,.0f} km", flush=True)

    stranded = rivers.compute_upstream(links)
    if stranded:
        print(f"  {stranded} links inside a network cycle, broken in on the "
              f"largest inflow", flush=True)
    chains = rivers.trace_chains(links)
    print(f"  {len(chains)} chains", flush=True)

    to_wgs84 = Transformer.from_crs(27700, 4326, always_xy=True)

    conf_parts: list[np.ndarray] = []
    z_parts: list[np.ndarray] = []
    xy_parts: list[np.ndarray] = []
    up_parts: list[np.ndarray] = []
    index: list[dict] = []
    offset = 0
    dropped = 0

    for chain in chains:
        coords = chain.coords()
        pts, dist = rivers.resample(coords, SPACING)
        if dist[-1] < MIN_CHAIN_LENGTH or len(pts) < 3:
            continue
        if not scot.contains(Point(pts[len(pts) // 2])):
            continue
        z_raw = dem.sample(pts[:, 0], pts[:, 1])
        if not np.isfinite(z_raw).all():
            # Interpolate short gaps (tile edges, coastal cells); drop the rest.
            ok = np.isfinite(z_raw)
            if ok.sum() < len(z_raw) * 0.8 or ok.sum() < 3:
                dropped += 1
                continue
            z_raw = np.interp(dist, dist[ok], z_raw[ok])
        z = condition(z_raw)

        screen = [max_gradient_at_scale(z, s) for s in SCALES]
        if max(screen) < MIN_SCREEN_GRADIENT:
            continue

        # Valley confinement: how far the lower bank rises 100 m out. Second-best
        # discriminator after catchment (see canyon.analyse).
        conf = confinement(dem.sample, pts[:, 0], pts[:, 1], z,
                           (CONFINE_RADIUS,))[CONFINE_RADIUS]

        # Upstream catchment length at each sample, from per-link accumulation.
        link_ends = np.cumsum([l.length for l in chain.links])
        # Name runs: a chain crosses several named watercourses, and a steep
        # reach should be reported under the name it carries locally.
        link_of = np.searchsorted(link_ends, dist, side="left").clip(0, len(chain.links) - 1)
        runs: list[list] = []
        for i, li in enumerate(link_of):
            nm = chain.links[int(li)].name
            if not runs or runs[-1][1] != nm:
                runs.append([int(i), nm])

        link_up = np.array([l.upstream_km + l.length / 1000 for l in chain.links])
        up_km = np.interp(dist, np.concatenate([[0.0], link_ends]),
                          np.concatenate([[chain.links[0].upstream_km], link_up]))

        lon, lat = to_wgs84.transform(pts[:, 0], pts[:, 1])
        # Fixed point at 1e-7 deg (~1cm), stored as deltas between quantised
        # positions so reconstruction is exact and each delta fits an int16.
        qlon = np.round(np.asarray(lon) * 1e7).astype(np.int64)
        qlat = np.round(np.asarray(lat) * 1e7).astype(np.int64)
        dlon = np.diff(qlon, prepend=qlon[0])
        dlat = np.diff(qlat, prepend=qlat[0])
        if np.abs(dlon).max() > 32767 or np.abs(dlat).max() > 32767:
            continue  # a resampling artefact, not a real reach

        n = len(pts)
        z_parts.append(np.round(z * 10).astype(np.int16))
        xy_parts.append((dlon.astype(np.int16), dlat.astype(np.int16)))
        up_parts.append(np.minimum(np.round(up_km * 10), 65535).astype(np.uint16))
        conf_parts.append(np.clip(np.round(np.nan_to_num(conf)), 0, 255).astype(np.uint8))
        index.append({
            "o": offset,
            "n": n,
            "name": chain.name,
            "runs": runs,
            "screen": [round(s, 4) for s in screen],
            "top": round(float(z[0]), 1),
            "bottom": round(float(z[-1]), 1),
            "lon0": int(qlon[0]),
            "lat0": int(qlat[0]),
        })
        offset += n

    total = offset
    print(f"  kept {len(index)} chains, {total} samples, "
          f"{total * SPACING / 1000:,.0f} km ({dropped} dropped for missing DEM)")

    out.mkdir(parents=True, exist_ok=True)
    payload.save(out, payload.Payload(
        meta={
            "spacing": SPACING,
            "scales": SCALES,
            "samples": total,
            "dem": "OS Terrain 50 (50m)",
            "confine_radius": CONFINE_RADIUS,
            "chains": index,
        },
        z=np.concatenate(z_parts),
        up=np.concatenate(up_parts),
        # Drainage area needs the whole national grid, so canyon.watershed fills
        # it in afterwards rather than holding up every build.
        drain=np.zeros(total, np.float32),
        conf=np.concatenate(conf_parts),
        dlon=np.concatenate([p[0] for p in xy_parts]),
        dlat=np.concatenate([p[1] for p in xy_parts]),
        spacing=SPACING,
    ))
    print(f"done in {time.time() - t0:.0f}s -> {out}")


def main() -> None:
    p = argparse.ArgumentParser()
    root = Path(__file__).resolve().parents[2]
    p.add_argument("--raw", type=Path, default=root / "data" / "raw")
    p.add_argument("--out", type=Path, default=root / "web" / "public" / "data")
    p.add_argument("--rivers", type=Path,
                   default=root / "data" / "raw" / "Data" / "oprvrs_gb.gpkg")
    p.add_argument("--bbox", type=float, nargs=4, default=BBOX,
                   metavar=("MINX", "MINY", "MAXX", "MAXY"),
                   help="BNG extent to compile (default: all Scotland)")
    a = p.parse_args()
    build(a.raw, a.out, a.rivers, tuple(a.bbox))


if __name__ == "__main__":
    main()
