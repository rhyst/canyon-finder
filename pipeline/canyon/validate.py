"""Check the compiled payload against known Scottish canyoning venues.

Run after a build to confirm the search surfaces places people actually descend.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np

from . import payload
from .payload import chain_lonlat

# Commercially operated or well-documented descents, located on their gorge.
# Keep in step with web/src/known.ts.
VENUES = {
    "Bruar (Falls of Bruar)": (-3.9315, 56.7810),
    "Nathrach (Kinlochleven)": (-4.9980, 56.7152),
    "Inchree (Glen Righ)": (-5.2167, 56.7149),
    "Acharn (Loch Tay)": (-4.0222, 56.5626),
    "Keltneyburn (Aberfeldy)": (-4.0118, 56.6323),
    "Keltie (Bracklinn)": (-4.1963, 56.2794),
    "Dollar Glen (Ochils)": (-3.7008, 56.1853),
    "Alva Glen (Ochils)": (-3.7995, 56.1655),
}


def load(out: Path):
    pay = payload.load(out)
    xy = np.empty((pay.total, 2), dtype=np.float64)
    for c in pay.chains:
        s = pay.chain(c)
        xy[s, 0], xy[s, 1] = chain_lonlat(c, pay.dlon, pay.dlat)
    return (pay.meta, pay.z.astype(np.float32) / 10,
            pay.up.astype(np.float32) / 10, xy, pay.spacing)


def best_segment(z: np.ndarray, spacing: float, min_len: float, max_len: float):
    """Steepest segment within the length window: (gradient, drop, length, i, j)."""
    lo = max(1, int(round(min_len / spacing)))
    hi = min(int(max_len / spacing), len(z) - 1)
    best = (0.0, 0.0, 0.0, 0, 0)
    for k in range(lo, hi + 1):
        drop = z[:-k] - z[k:]
        i = int(np.argmax(drop))
        g = float(drop[i]) / (k * spacing)
        if g > best[0]:
            best = (g, float(drop[i]), k * spacing, i, i + k)
    return best


def name_at(chain: dict, i: int) -> str:
    """The watercourse name carried at sample `i`, as the app reports it."""
    name = chain["name"]
    for start, run_name in chain["runs"]:
        if start > i:
            break
        if run_name:
            name = run_name
    return name


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--out", type=Path,
                   default=Path(__file__).resolve().parents[2] / "web" / "public" / "data")
    p.add_argument("--min-len", type=float, default=200)
    p.add_argument("--max-len", type=float, default=1200)
    a = p.parse_args()

    meta, z, up, xy, spacing = load(a.out)
    print(f"{'venue':26} {'watercourse':24} {'grad':>6} {'drop':>7} {'len':>6} "
          f"{'dist':>6}  dem")
    for name, (lon, lat) in VENUES.items():
        # Nearest sample to the venue point.
        d2 = (xy[:, 0] - lon) ** 2 * np.cos(np.radians(lat)) ** 2 + (xy[:, 1] - lat) ** 2
        idx = int(np.argmin(d2))
        dist_m = float(np.sqrt(d2[idx])) * 111_320
        chain = next(c for c in meta["chains"] if c["o"] <= idx < c["o"] + c["n"])
        zc = z[chain["o"]: chain["o"] + chain["n"]]
        grad, drop, length, i, j = best_segment(zc, spacing, a.min_len, a.max_len)
        reach = name_at(chain, i) or "unnamed"
        dem = chain.get("dem", "50 m")
        print(f"{name:26} {reach[:24]:24} {grad * 100:5.1f}% {drop:6.0f}m "
              f"{length:5.0f}m {dist_m:5.0f}m  {dem}")


if __name__ == "__main__":
    main()
