"""OS Open Rivers: read the link/node network and trace main-stem chains."""

from __future__ import annotations

import sqlite3
import struct
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

# Forms we treat as traversable watercourse. Lake links are kept (a burn may run
# through a lochan) but canal is dropped.
KEEP_FORMS = {"inlandRiver", "tidalRiver", "lake"}

_ENVELOPE_WORDS = {0: 0, 1: 4, 2: 6, 3: 6, 4: 8}


def gpkg_wkb(blob: bytes) -> bytes:
    """Strip the GeoPackage binary header, returning bare WKB."""
    flags = blob[3]
    env = _ENVELOPE_WORDS[(flags >> 1) & 0x07]
    return blob[8 + env * 8:]


def wkb_linestring(wkb: bytes) -> np.ndarray:
    """Parse a 2D WKB LINESTRING into an (n, 2) float64 array."""
    little = wkb[0] == 1
    endian = "<" if little else ">"
    geom_type = struct.unpack_from(endian + "I", wkb, 1)[0]
    if geom_type % 1000 != 2:
        raise ValueError(f"not a linestring: {geom_type}")
    n = struct.unpack_from(endian + "I", wkb, 5)[0]
    dims = {0: 2, 1: 3, 2: 3, 3: 4}[geom_type // 1000]
    arr = np.frombuffer(wkb, dtype=np.dtype(endian + "f8"), count=n * dims, offset=9)
    return np.ascontiguousarray(arr.reshape(n, dims)[:, :2])


@dataclass
class Link:
    id: str
    name: str
    start: str
    end: str
    coords: np.ndarray
    length: float
    form: str
    upstream_km: float = 0.0


@dataclass
class Chain:
    """A path down the network, following the largest tributary at each junction."""

    links: list[Link] = field(default_factory=list)

    @property
    def name(self) -> str:
        names = [l.name for l in self.links if l.name]
        if not names:
            return ""
        # Most-downstream named watercourse wins; it is the one people know.
        return max(set(names), key=lambda n: sum(l.length for l in self.links if l.name == n))

    def coords(self) -> np.ndarray:
        parts = [self.links[0].coords]
        for l in self.links[1:]:
            parts.append(l.coords[1:] if len(l.coords) > 1 else l.coords)
        return np.concatenate(parts)


def load_links(gpkg: Path, bbox: tuple[float, float, float, float]) -> list[Link]:
    minx, miny, maxx, maxy = bbox
    con = sqlite3.connect(f"file:{gpkg}?mode=ro", uri=True)
    rows = con.execute(
        "SELECT id, watercourse_name, start_node, end_node, geometry, length, form,"
        " flow_direction FROM watercourse_link"
    )
    links: list[Link] = []
    for rid, name, start, end, blob, length, form, flow in rows:
        if form not in KEEP_FORMS:
            continue
        coords = wkb_linestring(gpkg_wkb(blob))
        if coords[:, 0].max() < minx or coords[:, 0].min() > maxx:
            continue
        if coords[:, 1].max() < miny or coords[:, 1].min() > maxy:
            continue
        if flow == "in opposite direction":
            coords = coords[::-1]
            start, end = end, start
        links.append(Link(rid, name or "", start, end, coords, float(length or 0), form))
    con.close()
    return links


def compute_upstream(links: list[Link]) -> int:
    """Set upstream_km on each link: total watercourse length draining into its head.

    Returns the number of links a cycle stopped Kahn's algorithm from resolving.
    """
    by_end: dict[str, list[Link]] = defaultdict(list)
    for l in links:
        by_end[l.end].append(l)

    by_start: dict[str, list[Link]] = defaultdict(list)
    for l in links:
        by_start[l.start].append(l)

    # Where flow splits, the inherited total is divided between the branches, not
    # handed to each of them. Handing it to each is what a plain accumulation
    # does, and when the branches rejoin, the shared channel above them is counted
    # once per path — which compounds: 502 split nodes took the Kyle of Sutherland
    # to 2.7 million km upstream, 43x the whole Scottish network. Dividing keeps
    # every downstream total exact, because the shares recombine at the confluence,
    # and still gives a side channel a proportional figure rather than zero.
    share: dict[str, float] = {}
    for node, out in by_start.items():
        span = sum(l.length for l in out)
        for l in out:
            share[l.id] = (l.length / span) if span else 1.0 / len(out)

    # Kahn's algorithm over links: a link is ready once every link feeding its
    # start node has been processed.
    pending = {l.id: len(by_end.get(l.start, ())) for l in links}
    queue = [l for l in links if pending[l.id] == 0]
    done = 0
    while queue:
        l = queue.pop()
        done += 1
        total = l.upstream_km + l.length / 1000.0
        for nxt in by_start.get(l.end, ()):
            nxt.upstream_km += total * share[nxt.id]
            pending[nxt.id] -= 1
            if pending[nxt.id] == 0:
                queue.append(nxt)
    if done == len(links):
        return 0

    # A braided reach or a digitising loop leaves a cycle, and Kahn's strands not
    # just the cycle but everything below it. Break in on the largest inflow
    # first: releasing the biggest contributor lets the rest resolve normally,
    # rather than every stranded link falling back to its own length and reading
    # as a headwater. Catchment is the strongest feature and the default sort, so
    # a whole river system quietly ranking at zero is worth this much effort.
    stuck = [l for l in links if pending[l.id] > 0]
    for l in sorted(stuck, key=lambda l: (-l.upstream_km, l.id)):
        if pending[l.id] <= 0:
            continue  # released while the queue drained below
        pending[l.id] = 0
        queue = [l]
        while queue:
            cur = queue.pop()
            done += 1
            total = cur.upstream_km + cur.length / 1000.0
            for nxt in by_start.get(cur.end, ()):
                nxt.upstream_km += total * share[nxt.id]
                pending[nxt.id] -= 1
                if pending[nxt.id] == 0:
                    queue.append(nxt)

    # Anything still held is inside a cycle that the pass above could not open.
    for l in links:
        if pending[l.id] > 0:
            l.upstream_km = max(l.upstream_km, l.length / 1000.0)
    return len(stuck)


def trace_chains(links: list[Link]) -> list[Chain]:
    """Partition links into main-stem chains.

    Each link belongs to exactly one chain. At a confluence the chain continues
    into the downstream link, and the upstream link with the largest catchment
    claims it, so a chain reads as one continuous river from source to mouth.
    """
    by_start: dict[str, list[Link]] = defaultdict(list)
    by_end: dict[str, list[Link]] = defaultdict(list)
    for l in links:
        by_start[l.start].append(l)
        by_end[l.end].append(l)

    # The upstream link that claims each downstream link.
    claimed_by: dict[str, str] = {}
    for l in links:
        feeders = by_end.get(l.start, ())
        if feeders:
            claimed_by[l.id] = max(feeders, key=lambda f: (f.upstream_km, f.id)).id

    successor: dict[str, Link] = {}
    for l in links:
        for nxt in by_start.get(l.end, ()):
            if claimed_by.get(nxt.id) == l.id:
                successor[l.id] = nxt
                break

    is_successor = {s.id for s in successor.values()}
    chains: list[Chain] = []
    for l in links:
        if l.id in is_successor:
            continue  # not a chain head
        chain = Chain()
        cur: Link | None = l
        seen: set[str] = set()
        while cur is not None and cur.id not in seen:
            seen.add(cur.id)
            chain.links.append(cur)
            cur = successor.get(cur.id)
        chains.append(chain)
    return chains


def resample(coords: np.ndarray, spacing: float) -> tuple[np.ndarray, np.ndarray]:
    """Resample a polyline at fixed spacing. Returns (points, cumulative distance)."""
    seg = np.hypot(*(coords[1:] - coords[:-1]).T)
    cum = np.concatenate([[0.0], np.cumsum(seg)])
    total = cum[-1]
    if total < spacing:
        return coords[[0, -1]], np.array([0.0, total])
    n = int(total // spacing) + 1
    d = np.arange(n) * spacing
    if total - d[-1] > spacing * 0.5:
        d = np.append(d, total)
    x = np.interp(d, cum, coords[:, 0])
    y = np.interp(d, cum, coords[:, 1])
    return np.column_stack([x, y]), d


def selftest() -> None:
    """Accumulate over the two shapes that broke on real data.

    Run as `python -m canyon.rivers`. A braid counted shared channel once per
    downstream path and reached 43x the national network; a cycle stranded every
    link below it, leaving 25 River Eden links reading as headwaters.
    """
    def link(lid, start, end, km):
        return Link(lid, lid, start, end, np.zeros((2, 2)), km * 1000.0, "inlandRiver")

    # A diamond: source -> a -> {b, c} -> d. The shared source must count once.
    diamond = [link("s", "n0", "n1", 10), link("b", "n1", "n2", 1),
               link("c", "n1", "n2", 2), link("d", "n2", "n3", 1)]
    assert compute_upstream(diamond) == 0
    got = {l.id: round(l.upstream_km, 3) for l in diamond}
    # d sees all 13 km above it — the source plus both branches — and no more.
    assert got["d"] == 13.0, got
    # Each branch takes a share of the source rather than all of it or none.
    assert got["b"] + got["c"] == 10.0, got
    total = sum(l.length for l in diamond) / 1000
    assert max(got.values()) <= total, f"{got} exceeds the {total} km network"

    # A cycle, with real channel above it. Everything below must still resolve.
    cycle = [link("feed", "m0", "m1", 100), link("x", "m1", "m2", 1),
             link("y", "m2", "m1", 1), link("out", "m2", "m3", 1)]
    stranded = compute_upstream(cycle)
    assert stranded == 3, stranded
    # The loop still costs the outlet something — the node cannot tell a spurious
    # loop from a real braid, so it splits with it — but the water arrives instead
    # of the outlet reading as a headwater, which is what it did before.
    out = cycle[3].upstream_km
    assert out > 50, f"link below the cycle reads {out} km of the 100 above it"

    print("  diamond counts shared channel once")
    print(f"  cycle strands {stranded} links; the outlet below still gets "
          f"{out:.0f} of the 100 km above it, where it used to read 1")


if __name__ == "__main__":
    selftest()
