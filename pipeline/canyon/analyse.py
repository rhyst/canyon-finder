"""What separates a graded canyon from a steep burn that is not worth the walk.

Positives are graded descents (Basic, Moderate, Advanced). Canyon Log's "0 Stars"
entries are true negatives — visited and found unproductive — but there are only
17, so that comparison is indicative at best; the graded-vs-background separation
carries the weight. "Potential Canyon" means an unvisited lead, so it is neither
and is left out, along with Ungraded and Scramble.
"""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path

import numpy as np
from pyproj import Transformer

from .build import CONFINE_RADIUS, SQUARES
from .dem import Terrain50
from . import payload
from .features import RADII, confinement, reach_features
from .payload import chain_lonlat

GRADED = {"Basic", "Moderate", "Advanced"}
REJECTED = {"0 Stars"}  # visited, found not worth it
CONFINE_CAP = 60.0
FEATURES = ["gradient", "steepest_100m", "steepest_step", "steep_fraction",
            "step_variation", "catchment_km", "drain_km2", "top_m", "drop",
            "length", "confine_50m", "confine_100m", "confine_200m"]


def auc(pos: np.ndarray, neg: np.ndarray) -> float:
    """Probability a random positive scores above a random negative."""
    if not len(pos) or not len(neg):
        return float("nan")
    ranks = np.argsort(np.argsort(np.concatenate([pos, neg]))) + 1
    r_pos = ranks[: len(pos)].sum()
    return (r_pos - len(pos) * (len(pos) + 1) / 2) / (len(pos) * len(neg))


def main() -> None:
    root = Path(__file__).resolve().parents[2]
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--out", type=Path, default=root / "web" / "public" / "data")
    p.add_argument("--raw", type=Path, default=root / "data" / "raw")
    p.add_argument("--work", type=Path, default=root / "data" / "work")
    p.add_argument("--min-gradient", type=float, default=0.08,
                   help="floor for the background candidate pool")
    a = p.parse_args()

    pay = payload.load(a.out)
    meta, spacing = pay.meta, pay.spacing
    z_all, up_all, conf_all, drain_all = pay.z, pay.up, pay.conf, pay.drain
    logged = json.loads((a.out / "known.json").read_text())["canyons"]
    if not drain_all.any():
        print("payload carries no drainage area; run python -m canyon.watershed")
    dem = Terrain50.load(a.raw / "terr50", set(SQUARES),
                         cache=a.raw.parent / "work" / "terr50.npz")
    to_bng = Transformer.from_crs(4326, 27700, always_xy=True)

    # Chains we need: every labelled canyon, plus all chains for the background.
    labels: dict[int, list[tuple[dict, str]]] = defaultdict(list)
    for k in logged:
        group = "graded" if k["category"] in GRADED else (
            "rejected" if k["category"] in REJECTED else None)
        if group:
            labels[k["chain"]].append((k, group))
    n_graded = sum(1 for v in labels.values() for _, g in v if g == "graded")
    n_rej = sum(1 for v in labels.values() for _, g in v if g == "rejected")
    skipped = [k["category"] for k in logged
               if k["category"] not in GRADED | REJECTED]
    print(f"labelled: {n_graded} graded, {n_rej} zero-star; "
          f"{len(skipped)} excluded ({', '.join(sorted(set(skipped)))})")

    rows: dict[str, list[dict]] = {"graded": [], "rejected": [], "background": []}
    min_k = int(round(200 / spacing))
    max_k = int(round(600 / spacing))

    for ci, c in enumerate(meta["chains"]):
        interesting = ci in labels or max(c["screen"]) >= a.min_gradient
        if not interesting:
            continue
        s = slice(c["o"], c["o"] + c["n"])
        zc = z_all[s].astype(np.float64) / 10
        upc = up_all[s].astype(np.float64) / 10
        dr = drain_all[s]
        lon, lat = chain_lonlat(c, pay.dlon, pay.dlat)
        x, y = to_bng.transform(lon, lat)
        # 100 m is the radius that ships, so it comes from the payload — the same
        # bytes the browser scores on, LiDAR where a chain was refined. The other
        # radii are diagnostic only and are re-measured off Terrain 50.
        other = [r for r in RADII if r != CONFINE_RADIUS]
        conf = {r: np.nan_to_num(v) for r, v in
                confinement(dem.sample, np.asarray(x), np.asarray(y), zc, other).items()}
        conf[CONFINE_RADIUS] = conf_all[s].astype(np.float64)

        for k, group in labels.get(ci, ()):
            rows[group].append(
                reach_features(zc, upc, conf, k["i"], k["j"], spacing, dr))

        # Background: the steepest non-overlapping 200-600 m reaches on this chain.
        i = 0
        while i + min_k < len(zc):
            best = None
            for k in range(min_k, min(max_k, len(zc) - 1 - i) + 1):
                g = (zc[i] - zc[i + k]) / (k * spacing)
                if g >= a.min_gradient and (best is None or g > best[1]):
                    best = (k, g)
            if best is None:
                i += 1
                continue
            rows["background"].append(
                reach_features(zc, upc, conf, i, i + best[0], spacing, dr))
            i += best[0]

    for name, r in rows.items():
        print(f"  {name}: {len(r)} reaches")

    arrays = {g: {f: np.array([r[f] for r in rows[g]]) for f in FEATURES} for g in rows}

    print(f"\n{'feature':16} {'graded':>18} {'rejected':>18} {'background':>18} "
          f"{'AUC v rej':>9} {'AUC v bg':>8}")
    print("-" * 102)
    for f in FEATURES:
        g, r, b = arrays["graded"][f], arrays["rejected"][f], arrays["background"][f]
        fmt = (lambda v: f"{np.median(v):8.2f} ({np.percentile(v, 25):6.2f}-"
               f"{np.percentile(v, 75):6.2f})")
        print(f"{f:16} {fmt(g):>18} {fmt(r):>18} {fmt(b):>18} "
              f"{auc(g, r):9.2f} {auc(g, b):8.2f}")

    print("\nwhat a filter costs, measured on the graded set:")
    rules = [
        ("gradient >= 0.10", lambda d: d["gradient"] >= 0.10),
        ("gradient >= 0.15", lambda d: d["gradient"] >= 0.15),
        ("gradient >= 0.20", lambda d: d["gradient"] >= 0.20),
        ("catchment >= 2 km", lambda d: d["catchment_km"] >= 2),
        ("catchment >= 5 km", lambda d: d["catchment_km"] >= 5),
        # The bound the sliders actually set. Paired with the channel-length rows
        # above so the two ways of measuring water stay comparable.
        ("drainage >= 1 km2", lambda d: d["drain_km2"] >= 1),
        ("drainage >= 4 km2", lambda d: d["drain_km2"] >= 4),
        ("drainage >= 10 km2", lambda d: d["drain_km2"] >= 10),
        ("confine_100m >= 10", lambda d: d["confine_100m"] >= 10),
        ("confine_100m >= 20", lambda d: d["confine_100m"] >= 20),
        ("grad>=.10 & drain>=4", lambda d: (d["gradient"] >= 0.10) & (d["drain_km2"] >= 4)),
        ("grad>=.12 & drain>=4", lambda d: (d["gradient"] >= 0.12) & (d["drain_km2"] >= 4)),
        ("grad>=.15 & drain>=4", lambda d: (d["gradient"] >= 0.15) & (d["drain_km2"] >= 4)),
        ("grad>=.12 & drain>=4 & conf>=10",
         lambda d: (d["gradient"] >= 0.12) & (d["drain_km2"] >= 4) & (d["confine_100m"] >= 10)),
    ]
    n_bg = len(rows["background"])
    print(f"{'rule':32} {'graded kept':>11} {'0-star kept':>11} {'pool':>14} "
          f"{'sift per graded':>15}")
    print("-" * 88)
    for name, rule in rules:
        keep_g = rule(arrays["graded"]).mean()
        keep_r = rule(arrays["rejected"]).mean()
        pool = int(rule(arrays["background"]).sum())
        sift = pool / (keep_g * n_graded) if keep_g else float("inf")
        print(f"{name:32} {keep_g * 100:9.0f}% {keep_r * 100:10.0f}% "
              f"{pool:8,} ({pool / n_bg * 100:3.0f}%) {sift:14.0f}")

    fit_score(arrays, a.out)


def logistic(X: np.ndarray, y: np.ndarray, iters: int = 40) -> np.ndarray:
    """Newton-Raphson logistic fit. X already has an intercept column."""
    w = np.zeros(X.shape[1])
    for _ in range(iters):
        p = 1 / (1 + np.exp(-X @ w))
        g = X.T @ (y - p)
        s = p * (1 - p) + 1e-9
        H = X.T @ (X * s[:, None]) + 1e-6 * np.eye(X.shape[1])
        w += np.linalg.solve(H, g)
    return w


def design(arrays: dict[str, dict[str, np.ndarray]], group: str, cap: float,
           water: str = "catchment_km") -> np.ndarray:
    d = arrays[group]
    return np.column_stack([
        d["gradient"],
        np.log1p(np.clip(d[water], 0, cap)),
        np.clip(d["confine_100m"], 0, CONFINE_CAP),
    ])


# Caps worth trying for each way of measuring how much water a reach carries.
WATER_CAPS = {
    "catchment_km": (10, 20, 30, 50, 100, 1e6),
    "drain_km2": (5, 20, 50, 200, 1000, 1e6),
}


def fit_score(arrays: dict[str, dict[str, np.ndarray]], out: Path) -> None:
    """Fit graded-vs-background on the three features that carry signal.

    Two of them are settled — gradient and confinement. The third is "how much
    water", and there are two ways to measure it, so both are fitted and the
    better wins. Either way the term is capped: past the graded p90 there is no
    evidence that more water means more canyon, and uncapped the term ranks major
    rivers — the Clyde, 600 km of channel — above every real gorge.
    """
    print("\nprospect score, choosing how to measure water and where to cap it:")
    print(f"  {'water':14} {'cap':>8} {'AUC vs bg':>10} {'AUC vs 0-star':>14} "
          f"{'top-2% graded':>14}")
    results = []
    for water, caps in WATER_CAPS.items():
        if not arrays["graded"][water].any():
            continue
        for cap in caps:
            pos, bg, rej = (design(arrays, g, cap, water)
                            for g in ("graded", "background", "rejected"))
            mu, sd = bg.mean(axis=0), bg.std(axis=0)
            Xp, Xb, Xr = ((M - mu) / sd for M in (pos, bg, rej))
            X = np.column_stack([np.ones(len(Xp) + len(Xb)), np.vstack([Xp, Xb])])
            y = np.concatenate([np.ones(len(Xp)), np.zeros(len(Xb))])
            w = logistic(X, y)
            score = lambda M: np.column_stack([np.ones(len(M)), M]) @ w
            sp, sb, sr = score(Xp), score(Xb), score(Xr)
            top = (sp >= np.quantile(sb, 0.98)).mean()
            results.append((water, cap, auc(sp, sb), auc(sp, sr), top, w, mu, sd))
            print(f"  {water:14} {cap:8,.0f} {auc(sp, sb):10.3f} "
                  f"{auc(sp, sr):14.3f} {top * 100:13.0f}%")

    # 0-star is the comparison that matters: it is the one that says "worth it".
    water, cap, a_bg, a_rej, top, w, mu, sd = max(
        results, key=lambda r: (round(r[3], 3), r[2]))
    print(f"  chose {water} capped at {cap:,.0f} — AUC {a_bg:.3f} vs background, "
          f"{a_rej:.3f} vs 0-star, top 2% holds {top * 100:.0f}% of graded")
    for n, c in zip(("gradient", f"log1p({water}, capped)", "confine_100m"), w[1:]):
        print(f"    {n:26} {c:+.3f}")

    (out / "score.json").write_text(json.dumps({
        "transform": [
            {"name": "gradient"},
            {"name": water, "cap": cap, "log1p": True},
            {"name": "confine_100m", "cap": CONFINE_CAP},
        ],
        "mean": mu.tolist(),
        "sd": sd.tolist(),
        "weights": w.tolist(),
        "fitted_on": {"graded": int(len(arrays["graded"]["gradient"])),
                      "background": int(len(arrays["background"]["gradient"]))},
        "auc_vs_background": round(float(a_bg), 3),
        "auc_vs_zero_star": round(float(a_rej), 3),
    }))
    print(f"  wrote {out / 'score.json'}")


if __name__ == "__main__":
    main()
