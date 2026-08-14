"""Drainage area at every profile sample, from a D8 flow accumulation.

The payload's catchment figure is upstream *channel length*, which reads near
zero for a first-order headwater however much ground drains into it. That is
where the ranking goes blind: canyon.rank scores Allt an Earrochd and High Grain
worst of all the graded canyons purely because their strongest feature cannot see
them. This measures the area instead, off the DEM already downloaded.

The river network is burned into the DEM before routing, deeper the more channel
drains into a link. Two things come free from that: flow follows OS Open Rivers
rather than a 50 m DEM's guess at where the channel runs, and every channel falls
downstream even across a loch, so flats never trap flow.

    uv run python -m canyon.watershed              # all Scotland at 100 m, ~1 GB
    uv run python -m canyon.watershed --cell 50    # 4x the cells and the memory

There is no --bbox: a drainage area is only correct if the whole basin above it is
in the grid, so this is national or nothing.
"""

from __future__ import annotations

import argparse
import csv
import heapq
import math
import time
import urllib.request
import warnings
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from pyproj import Transformer

from . import payload, rivers
from .build import BBOX, SQUARES
from .dem import CELL, N, TILE, Terrain50
from .payload import chain_lonlat

# Cells at or below this drain off the map. Terrain 50 carries sea as data near
# zero, not as nodata, so without this the coast becomes one national flat.
SEA = 0.0
# Depth the mapped channel is dropped by, and the extra per km of upstream
# channel. The tilt stays under a metre on all but the largest rivers — inside
# the DEM's own error — and it is what stops a loch surface trapping flow.
BURN = 50.0
BURN_SLOPE = 0.01
EPS = 0.001  # metres a pit is raised above its lowest neighbour
# Trailing samples treated as possibly sharing a cell with the river the chain
# joins, and the growth across them that reads as contamination rather than water.
# Five 25 m samples comfortably span one 100 m cell.
TAIL = 5
CONFLUENCE_SLACK = 4.0

OFFSETS = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]

# Every gauged catchment in the UK, with a grid reference and a measured area.
# This is the validation: 1,600 known answers at known points, rather than a
# handful of basin totals that depend on where a river stops being that name.
NRFA_STATIONS = ("https://nrfaapps.ceh.ac.uk/nrfa/ws/station-info"
                 "?station=*&format=csv&fields=id,name,easting,northing,"
                 "catchment-area")
# A station's grid reference can sit a cell or two off the modelled channel, so
# the comparison takes the largest basin within this many cells of it.
SNAP_CELLS = 2
# Gauged catchments smaller than this many cells are excluded from the
# comparison: below a few dozen cells the disagreement measures the grid.
MIN_GAUGED_CELLS = 25


@dataclass
class Grid:
    """A national raster in BNG. Row 0 is the southernmost, NaN drains off-map."""

    z: np.ndarray
    x0: float
    y0: float
    cell: float

    def index(self, x: np.ndarray, y: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """Row and column of BNG coordinates, both -1 outside the grid."""
        col = np.floor((np.asarray(x) - self.x0) / self.cell).astype(np.int64)
        row = np.floor((np.asarray(y) - self.y0) / self.cell).astype(np.int64)
        off = ((col < 0) | (row < 0)
               | (col >= self.z.shape[1]) | (row >= self.z.shape[0]))
        return np.where(off, -1, row), np.where(off, -1, col)


def assemble(dem: Terrain50, cell: float) -> Grid:
    """Every loaded tile as one array, block-averaged to `cell` metres."""
    f = int(round(cell / CELL))
    if f < 1 or N % f:
        raise SystemExit(f"--cell must be {CELL:g} m times a divisor of {N}")
    keys = np.array(list(dem.tiles))
    tx0, ty0 = int(keys[:, 0].min()), int(keys[:, 1].min())
    per = N // f
    z = np.full(((int(keys[:, 1].max()) - ty0 + 1) * per,
                 (int(keys[:, 0].max()) - tx0 + 1) * per), np.nan, np.float32)
    for (tx, ty), tile in dem.tiles.items():
        block = tile[::-1]  # an ASC grid starts at its northernmost row
        if f > 1:
            with warnings.catch_warnings():  # all-nodata blocks are expected
                warnings.simplefilter("ignore", RuntimeWarning)
                block = np.nanmean(block.reshape(per, f, per, f), axis=(1, 3))
        z[(ty - ty0) * per:(ty - ty0 + 1) * per,
          (tx - tx0) * per:(tx - tx0 + 1) * per] = block
    z[z <= SEA] = np.nan
    return Grid(z, tx0 * TILE, ty0 * TILE, cell)


def burn(grid: Grid, links: list[rivers.Link]) -> int:
    """Drop mapped channels into the grid, deeper the more water they carry."""
    depth = np.zeros(grid.z.shape, np.float32)
    # Ascending depth, so a plain assignment leaves the deepest claim standing
    # and a confluence keeps the downstream link's value.
    order = sorted(links, key=lambda l: l.upstream_km + l.length / 1000)
    for l in order:
        pts, dist = rivers.resample(l.coords, grid.cell / 2)
        row, col = grid.index(pts[:, 0], pts[:, 1])
        ok = row >= 0
        # Per point, not per link: a loch is one link, so a per-link constant
        # would leave its surface dead flat.
        d = BURN + BURN_SLOPE * (l.upstream_km + dist / 1000)
        depth[row[ok], col[ok]] = d[ok]
    hit = (depth > 0) & np.isfinite(grid.z)
    grid.z[hit] -= depth[hit]
    return int(hit.sum())


def _neighbours(z: np.ndarray, idx: np.ndarray):
    """Yields (elevation, flat index, distance in cells) per neighbour.

    Elevation is -inf and the index -1 wherever flow leaves the map, so an
    off-grid or off-land neighbour always wins as the steepest descent.
    """
    nrows, ncols = z.shape
    zf = z.reshape(-1)
    r, c = np.divmod(idx, ncols)
    for dr, dc in OFFSETS:
        nr, nc = r + dr, c + dc
        inside = (nr >= 0) & (nr < nrows) & (nc >= 0) & (nc < ncols)
        ni = np.where(inside, nr * ncols + nc, 0)
        v = zf[ni]
        ok = inside & np.isfinite(v)
        yield np.where(ok, v, -np.inf), np.where(ok, ni, -1), math.hypot(dr, dc)


def outlets(z: np.ndarray, idx: np.ndarray) -> np.ndarray:
    """Land cells water can leave from: those touching the sea or the grid edge."""
    leaves = np.zeros(idx.shape, bool)
    for v, _, _ in _neighbours(z, idx):
        leaves |= ~np.isfinite(v)
    return idx[leaves]


def resolve(z: np.ndarray, idx: np.ndarray) -> int:
    """Fill every depression and flat, leaving each cell a lower neighbour.

    Priority flood outwards from the coast, raising each cell to at least a hair
    above the one it was reached from. Every cell therefore ends with a strictly
    downhill path to the sea, which is what both the routing and the
    highest-first accumulation order rely on.

    Iteratively raising pits instead cannot do this: on a flat — a loch, a bog —
    the lowest neighbour is level, so each pass lifts the surface by one epsilon
    and a national run leaves tens of thousands of lochs still trapping flow.
    Returns the number of cells raised.
    """
    nrows, ncols = z.shape
    zf = z.reshape(-1)
    seen = np.zeros(zf.shape, bool)
    start = outlets(z, idx)
    seen[start] = True
    heap = [(float(v), int(i)) for v, i in zip(zf[start], start)]
    heapq.heapify(heap)

    raised = 0
    while heap:
        zv, i = heapq.heappop(heap)
        r, c = divmod(i, ncols)
        for dr, dc in OFFSETS:
            nr, nc = r + dr, c + dc
            if not (0 <= nr < nrows and 0 <= nc < ncols):
                continue
            j = nr * ncols + nc
            if seen[j]:
                continue
            nv = zf[j]
            if not (nv == nv):  # NaN: off-land, and not ours to flood
                continue
            seen[j] = True
            if nv <= zv:
                nv = zv + EPS
                raised += 1
                zf[j] = nv
            heapq.heappush(heap, (float(nv), j))
    return raised


def route(z: np.ndarray, idx: np.ndarray, cell: float) -> np.ndarray:
    """D8 receiver of each cell as a flat index, -1 where flow leaves the map."""
    here = z.reshape(-1)[idx]
    best = np.zeros(idx.shape, np.float32)
    at = np.full(idx.shape, -1, np.int64)
    for v, ni, d in _neighbours(z, idx):
        slope = (here - v) / (d * cell)
        take = slope > best
        best[take] = slope[take]
        at[take] = ni[take]
    return at


def accumulate(z: np.ndarray, idx: np.ndarray, dest: np.ndarray,
               cell: float) -> np.ndarray:
    """Area draining through each cell, in km².

    Highest-first is a topological order here — flow only ever goes to a strictly
    lower cell — so every donor is added before its receiver. The walk is a plain
    Python loop because the dependency chain cannot be vectorised; it costs a few
    seconds per 10M land cells and is the reason `--cell` defaults to 100 m.
    """
    pos = np.full(z.size, -1, np.int32)
    pos[idx] = np.arange(len(idx), dtype=np.int32)
    recv = np.where(dest >= 0, pos[np.maximum(dest, 0)], -1).tolist()
    order = np.argsort(-z.reshape(-1)[idx], kind="stable").tolist()
    acc = [1.0] * len(idx)
    for i in order:
        j = recv[i]
        if j >= 0:
            acc[j] += acc[i]
    return np.asarray(acc, np.float32) * (cell * cell / 1e6)


def clamp_tail(area: np.ndarray) -> int:
    """Hold trailing samples that have read the basin of the river they join.

    A chain that ends at a confluence shares its last cell with the bigger river
    claiming the link below, so at 100 m the final sample or two can come back
    with the trunk's whole basin: Allt an Earrochd, 0.6 km of channel, read
    118 km². Only the tail is suspect, and it is compared against the sample just
    above it rather than against its own neighbour — comparing each sample to the
    last means one held value pins everything after it, which pinned 74% of the
    payload when tried. On a main stem the tail grows by a few percent, so the
    rule never fires there. Returns how many samples were held.
    """
    if len(area) <= TAIL:
        return 0
    ref = float(area[-TAIL - 1])
    if ref <= 0:
        return 0
    tail = area[-TAIL:]
    bad = tail > ref * CONFLUENCE_SLACK
    tail[bad] = ref
    return int(bad.sum())


def sample_chains(grid: Grid, area: np.ndarray, meta: dict, dlon: np.ndarray,
                  dlat: np.ndarray, total: int) -> tuple[np.ndarray, int]:
    """Drainage area in km² at every sample of every chain in the payload."""
    to_bng = Transformer.from_crs(4326, 27700, always_xy=True)
    out = np.zeros(total, np.float32)
    held = 0
    for c in meta["chains"]:
        lon, lat = chain_lonlat(c, dlon, dlat)
        x, y = to_bng.transform(lon, lat)
        row, col = grid.index(np.asarray(x), np.asarray(y))
        # The exact cell, not a neighbourhood maximum: the network was burned in,
        # so a chain's samples land on its own channel cells. Reaching wider lets
        # a river 200 m away donate its basin to a headwater burn.
        here = np.where(row >= 0, area[np.maximum(row, 0), np.maximum(col, 0)], 0)
        held += clamp_tail(here)
        # Drainage area only grows downstream.
        out[c["o"]:c["o"] + c["n"]] = np.maximum.accumulate(here)
    return out, held


def gauged_catchments(cache: Path) -> list[tuple[str, float, float, float]]:
    """Every NRFA gauging station as (name, easting, northing, area km²)."""
    if not cache.exists():
        cache.parent.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(NRFA_STATIONS, timeout=120) as resp:
            cache.write_bytes(resp.read())
    rows = []
    for row in csv.DictReader(cache.read_text().splitlines()):
        try:
            rows.append((row["name"], float(row["easting"]),
                         float(row["northing"]), float(row["catchment-area"])))
        except (KeyError, TypeError, ValueError):
            continue  # a station without a grid reference or a measured area
    return rows


def snap(area: np.ndarray, row: int, col: int) -> float | None:
    """Largest basin within SNAP_CELLS of a point, or None if there is none.

    A gauge's grid reference is only good to a cell or two, and the largest basin
    nearby is the flow path it sits on. Two apparently better rules measured
    worse: snapping to the nearest *rasterised* channel cell reads 0.01 km² on
    the Dee, because a centreline cell need not be one the D8 path uses, and
    preferring the smaller basin at a tie picks side channels over trunks.

    The bias this leaves is one-sided and known: a gauge at a tributary mouth can
    pick up the river it joins, which is why the Burn of Carron reads the Spey.
    """
    r0, r1 = max(0, row - SNAP_CELLS), row + SNAP_CELLS + 1
    c0, c1 = max(0, col - SNAP_CELLS), col + SNAP_CELLS + 1
    near = area[r0:r1, c0:c1]
    return float(near.max()) if near.size and near.max() > 0 else None


def validate(grid: Grid, area: np.ndarray, cache: Path) -> None:
    """Compare the routed basin against every gauged catchment in the grid.

    This is the check that matters: a measured area at a known grid reference,
    1,600 times over, rather than a handful of whole-river totals that depend on
    where a river stops carrying its name.
    """
    minx, miny, maxx, maxy = BBOX
    floor = MIN_GAUGED_CELLS * grid.cell ** 2 / 1e6
    got, want, names = [], [], []
    outside = small = missed = 0
    for name, east, north, published in gauged_catchments(cache):
        # The river network was only read inside BBOX, so a station below it has
        # nothing burned upstream and would report an empty basin. Northern
        # England is in the DEM but not in the network.
        if not (minx <= east <= maxx and miny <= north <= maxy):
            outside += 1
            continue
        # Moor House runs gauges on sub-hectare plots. A 100 m cell cannot hold
        # a 0.1 km² catchment, so comparing against one measures the grid, not
        # the routing.
        if published < floor:
            small += 1
            continue
        row, col = grid.index(np.array([east]), np.array([north]))
        if row[0] < 0:
            outside += 1
            continue
        hit = snap(area, int(row[0]), int(col[0]))
        if hit is None:
            missed += 1
            continue
        got.append(hit)
        want.append(published)
        names.append(name)

    got, want = np.array(got), np.array(want)
    if not len(got):
        print("\nno gauged catchments inside the grid")
        return
    ratio = got / want
    print(f"\nagainst {len(got):,} gauged catchments (NRFA): "
          f"{outside:,} outside the network extent, {small:,} below "
          f"{floor:g} km2, {missed:,} with no routed basin within "
          f"{SNAP_CELLS} cells")
    print(f"  {'catchment':>16} {'n':>5} {'median ratio':>13} {'within 10%':>11} "
          f"{'within 25%':>11}")
    bands = [(0.0, 5.0, "under 5 km2"), (5.0, 50.0, "5-50 km2"),
             (50.0, 500.0, "50-500 km2"), (500.0, np.inf, "over 500 km2"),
             (0.0, np.inf, "all")]
    for lo, hi, label in bands:
        m = (want >= lo) & (want < hi)
        if not m.any():
            continue
        r = ratio[m]
        print(f"  {label:>16} {m.sum():5,} {np.median(r):13.3f} "
              f"{np.mean(np.abs(r - 1) < 0.10) * 100:10.0f}% "
              f"{np.mean(np.abs(r - 1) < 0.25) * 100:10.0f}%")
    order = np.argsort(-np.abs(np.log(ratio)))
    print("  worst disagreements:")
    for i in order[:5]:
        print(f"    {names[i][:34]:35} routed {got[i]:8,.1f}  "
              f"gauged {want[i]:8,.1f}  x{ratio[i]:.2f}")


def report(meta: dict, up: np.ndarray, drain: np.ndarray) -> None:
    """Drainage area against the channel length it is meant to replace."""
    length = up.astype(np.float64) / 10
    ok = drain > 0
    print(f"\nsamples with an area: {ok.sum():,} of {len(drain):,} "
          f"({ok.mean() * 100:.1f}%)")
    print(f"  median area {np.median(drain[ok]):.2f} km2, "
          f"p95 {np.percentile(drain[ok], 95):.1f} km2, "
          f"max {drain.max():,.0f} km2")
    both = ok & (length > 0)
    print(f"  log correlation with upstream channel length: "
          f"{np.corrcoef(np.log1p(length[both]), np.log1p(drain[both]))[0, 1]:.3f}")

    # The headwaters canyon.rank ranks worst. Head and foot are both shown
    # because only the head is the canyon's own: quoting a chain's maximum credits
    # a burn with everything its river collects kilometres downstream, which is
    # how High Grain came to be reported at 10 km² when 0.3 drains into it.
    print("\nheadwater burns, where channel length reads near zero:")
    print(f"  {'watercourse':24} {'channel km':>10} {'km2 at head':>12} "
          f"{'km2 at foot':>12}")
    for name in ("Allt an Earrochd", "High Grain", "Allt Coire Sgamadail"):
        hit = next((c for c in meta["chains"] if c["name"] == name
                    or any(n == name for _, n in c["runs"])), None)
        if hit is None:
            print(f"  {name:24} {'not in payload':>36}")
            continue
        s = slice(hit["o"], hit["o"] + hit["n"])
        print(f"  {name:24} {length[s].max():10.2f} {drain[s][0]:12.2f} "
              f"{drain[s][-1]:12.2f}")


def selftest() -> None:
    """Route synthetic grids whose answer is known, on the cases that bit.

    Every one of these was a real failure first: flats left 34k lochs trapping
    flow and capped the largest basin at 327 km², and a per-sample confluence
    clamp pinned 74% of the payload.
    """
    def check(z: np.ndarray, label: str) -> None:
        land = np.flatnonzero(np.isfinite(z))
        resolve(z, land)
        dest = route(z, land, 100.0)
        acc = accumulate(z, land, dest, 100.0)
        leaves = acc[dest < 0].sum()
        assert np.isclose(leaves, len(land) * 0.01, rtol=1e-4), \
            f"{label}: {leaves:.3f} km2 left a grid holding {len(land) * 0.01:.3f}"
        sinks = int(((dest < 0) & ~np.isin(land, outlets(z, land))).sum())
        assert not sinks, f"{label}: {sinks} cells still trap flow"
        print(f"  {label:24} {len(land):6,} cells, all area accounted for")

    def tilt(rows: int, cols: int) -> np.ndarray:
        return np.tile(np.arange(rows, dtype=np.float32)[:, None] * 10.0, (1, cols))

    check(tilt(10, 10), "uniform tilt")
    z = tilt(10, 10)
    z[5, 5] = -50.0
    check(z, "single deep pit")
    z = tilt(40, 12)
    z[10:30, 4:8] = 100.0
    check(z, "long flat basin")
    z = tilt(20, 20)
    z[6:14, 6:14] = 5.0
    z[9:11, 6:14] = 1.0
    check(z, "closed basin with lip")

    area = np.array([1.0, 1.1, 1.2, 1.2, 1.3, 1.3, 1.3, 1.3, 118.0, 118.0], np.float32)
    assert clamp_tail(area) == 2, area
    assert area.max() < 2, area
    smooth = np.linspace(1.0, 1.4, 12).astype(np.float32)
    assert clamp_tail(smooth) == 0, smooth
    print("  tail clamp                fires on a trunk, not on real growth")


def main() -> None:
    root = Path(__file__).resolve().parents[2]
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--out", type=Path, default=root / "web" / "public" / "data")
    p.add_argument("--raw", type=Path, default=root / "data" / "raw")
    p.add_argument("--work", type=Path, default=root / "data" / "work")
    p.add_argument("--rivers", type=Path,
                   default=root / "data" / "raw" / "Data" / "oprvrs_gb.gpkg")
    p.add_argument("--cell", type=float, default=100.0,
                   help="routing cell size in metres (default 100)")
    p.add_argument("--selftest", action="store_true",
                   help="route synthetic grids with known answers and stop")
    a = p.parse_args()

    if a.selftest:
        selftest()
        return

    t0 = time.time()
    dem = Terrain50.load(a.raw / "terr50", set(SQUARES),
                         cache=a.work / "terr50.npz")
    grid = assemble(dem, a.cell)
    dem.tiles = {}
    land = np.flatnonzero(np.isfinite(grid.z))
    print(f"grid {grid.z.shape[1]} x {grid.z.shape[0]} at {a.cell:g} m, "
          f"{len(land):,} land cells ({time.time() - t0:.0f}s)", flush=True)

    links = rivers.load_links(a.rivers, BBOX)
    rivers.compute_upstream(links)
    print(f"burned {burn(grid, links):,} channel cells from {len(links):,} links "
          f"({time.time() - t0:.0f}s)", flush=True)
    del links

    print(f"filled {resolve(grid.z, land):,} cells ({time.time() - t0:.0f}s)",
          flush=True)

    dest = route(grid.z, land, a.cell)
    print(f"routed, {int((dest < 0).sum()):,} outlets ({time.time() - t0:.0f}s)", flush=True)

    flat = np.zeros(grid.z.size, np.float32)
    flat[land] = accumulate(grid.z, land, dest, a.cell)
    area = flat.reshape(grid.z.shape)
    print(f"accumulated, largest basin {area.max():,.0f} km2 "
          f"({time.time() - t0:.0f}s)", flush=True)

    validate(grid, area, a.work / "nrfa_stations.csv")

    pay = payload.load(a.out)
    meta, total = pay.meta, pay.total
    drain, held = sample_chains(grid, area, meta, pay.dlon, pay.dlat, total)
    print(f"sampled {total:,} profile points, {held:,} held at a shared "
          f"confluence cell ({time.time() - t0:.0f}s)", flush=True)
    report(meta, pay.up, drain)

    pay.drain = drain
    meta["drain_cell"] = a.cell
    payload.save(a.out, pay)
    size = (a.out / "profiles.bin").stat().st_size
    print(f"\nwrote drainage into {a.out / 'profiles.bin'} "
          f"({size / 1e6:.1f} MB) in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
