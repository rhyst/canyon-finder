"""Steep sections: the unit the app lists, filters and scores.

Each chain's long profile is split into pieces of uniform slope (penalised
least squares, solved exactly), and runs of steep pieces become sections. A
section is a property of the river, not of a query, so one stretch of water has
one set of numbers and one score.

Stored as `sections: [[i, j], ...]` (inclusive samples) on each chain in
profiles.json. Elevation decides them, so this runs after refine.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

from . import payload

# Chosen by sweeping against Canyon Log: 92% of descents rated 2+ stars and 45%
# of the 0-star ones fall in a section at these settings.
PENALTY = 60.0  # m² a breakpoint must save; larger means fewer, longer pieces
STEEP = 0.05
BRIDGE_M = 200.0  # gentler water a section may span: pool-drop is one canyon
MIN_PIECE = 3  # samples
MIN_DROP = 10.0  # metres


def segment(z: np.ndarray, penalty: float = PENALTY) -> list[int]:
    """Breakpoints (including 0 and len) of the best piecewise-linear fit."""
    n = len(z)
    if n < 2 * MIN_PIECE:
        return [0, n]
    x = np.arange(n, dtype=float)
    acc = lambda v: np.concatenate([[0.0], np.cumsum(v)])
    sx, sz, sxx, sxz, szz = acc(x), acc(z), acc(x * x), acc(x * z), acc(z * z)
    best = np.full(n + 1, np.inf)
    best[0] = -penalty
    prev = np.zeros(n + 1, int)
    for j in range(MIN_PIECE, n + 1):
        i = np.arange(0, j - MIN_PIECE + 1)
        m = j - i
        mx, mz = (sx[j] - sx[i]) / m, (sz[j] - sz[i]) / m
        vxx = sxx[j] - sxx[i] - m * mx * mx
        vxz = sxz[j] - sxz[i] - m * mx * mz
        vzz = szz[j] - szz[i] - m * mz * mz
        cost = best[i] + np.maximum(vzz - vxz * vxz / np.maximum(vxx, 1e-9), 0) + penalty
        k = int(np.argmin(cost))
        best[j], prev[j] = cost[k], i[k]
    cuts = [n]
    while cuts[-1] > 0:
        cuts.append(int(prev[cuts[-1]]))
    return cuts[::-1]


def sections(z: np.ndarray, spacing: float) -> list[list[int]]:
    """Inclusive [i, j] sample ranges of the steep sections, downstream order."""
    cuts = segment(z)
    steep: list[list[int]] = []
    for a, b in zip(cuts, cuts[1:]):
        # The fall between two pieces is a piece of its own: a waterfall
        # between two pools leaves neither pool steep.
        if a > 0 and (z[a - 1] - z[a]) / spacing >= STEEP:
            steep.append([a - 1, a])
        if b - 1 > a and (z[a] - z[b - 1]) / ((b - 1 - a) * spacing) >= STEEP:
            steep.append([a, b - 1])
    bridge = BRIDGE_M / spacing
    out: list[list[int]] = []
    for a, b in steep:
        if out and a - out[-1][1] <= bridge:
            out[-1][1] = b
        else:
            out.append([a, b])
    return [[a, b] for a, b in out if z[a] - z[b] >= MIN_DROP]


def selftest() -> None:
    flat = lambda n, z0: z0 - 0.2 * np.arange(n)
    z = np.concatenate([flat(20, 300), 296 - 5.0 * np.arange(1, 13), flat(20, 235)])
    got = sections(z, 25.0)
    assert len(got) == 1 and abs(got[0][0] - 19) <= 1 and abs(got[0][1] - 32) <= 1, got
    # Two falls 100 m apart are one section; a kilometre apart, two.
    step = np.concatenate([flat(10, 200), flat(4, 180), flat(10, 160)])
    assert len(sections(step, 25.0)) == 1, sections(step, 25.0)
    far = np.concatenate([flat(10, 200), flat(40, 180), flat(10, 150)])
    assert len(sections(far, 25.0)) == 2, sections(far, 25.0)
    assert sections(flat(60, 100), 25.0) == []
    print("sections selftest passed")


def main() -> None:
    root = Path(__file__).resolve().parents[2]
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--out", type=Path, default=root / "web" / "public" / "data")
    p.add_argument("--selftest", action="store_true")
    a = p.parse_args()
    if a.selftest:
        return selftest()

    pay = payload.load(a.out)
    total = 0
    for c in pay.chains:
        z = pay.z[pay.chain(c)].astype(float) / 10
        c["sections"] = sections(z, pay.spacing)
        total += len(c["sections"])
    (a.out / "profiles.json").write_text(json.dumps(pay.meta))
    print(f"{total:,} sections on {sum(1 for c in pay.chains if c['sections']):,} "
          f"of {len(pay.chains):,} chains")


if __name__ == "__main__":
    main()
