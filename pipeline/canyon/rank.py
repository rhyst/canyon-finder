"""Rank whole watercourses by how much they look like a canyon.

The reach-level score in canyon.analyse answers "is this 300 m steep". This
answers the question you actually ask when choosing where to drive: is this
*watercourse* worth a day. It fits on group-level features exported from the
app's own search (web/tools/export-groups.ts), so the model and the UI cannot
drift apart.

Positives are groups holding a graded Canyon Log descent. Background is every
other group. The 17 "0 Stars" groups are held out entirely and only used to
report how well the ranking separates worthwhile from visited-and-rejected —
they are too few to train on.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

from .analyse import auc, logistic

# Candidate features, with the transform used before standardising.
CANDIDATES: list[tuple[str, dict]] = [
    ("peak_gradient", {}),
    ("overall_gradient", {}),
    ("steep_drop", {"log1p": True}),
    ("steep_length", {"log1p": True}),
    ("span_length", {"log1p": True}),
    ("continuity", {}),
    ("reaches", {"log1p": True}),
    ("catchment_km", {"log1p": True, "cap": 50.0}),
    ("confine_median", {"cap": 60.0}),
    ("confine_max", {"cap": 60.0}),
    ("top_m", {"cap": 900.0}),
]
FOLDS = 5


def column(rows: list[dict], name: str, spec: dict) -> np.ndarray:
    v = np.array([float(r[name]) for r in rows])
    if "cap" in spec:
        v = np.minimum(v, spec["cap"])
    if spec.get("log1p"):
        v = np.log1p(np.maximum(v, 0))
    return v


def fit(X: np.ndarray, y: np.ndarray) -> np.ndarray:
    return logistic(np.column_stack([np.ones(len(X)), X]), y)


def apply(w: np.ndarray, X: np.ndarray) -> np.ndarray:
    return np.column_stack([np.ones(len(X)), X]) @ w


def cv_auc(X: np.ndarray, y: np.ndarray, seed: int = 0) -> float:
    """Out-of-fold AUC. With 84 positives, in-sample AUC flatters badly."""
    rng = np.random.default_rng(seed)
    order = rng.permutation(len(y))
    folds = np.array_split(order, FOLDS)
    scores = np.zeros(len(y))
    for f in folds:
        mask = np.ones(len(y), bool)
        mask[f] = False
        mu, sd = X[mask].mean(axis=0), X[mask].std(axis=0) + 1e-9
        w = fit((X[mask] - mu) / sd, y[mask])
        scores[f] = apply(w, (X[f] - mu) / sd)
    return auc(scores[y == 1], scores[y == 0])


def main() -> None:
    root = Path(__file__).resolve().parents[2]
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--groups", type=Path, default=root / "data" / "work" / "groups.json")
    p.add_argument("--out", type=Path, default=root / "web" / "public" / "data")
    p.add_argument("--max-features", type=int, default=5)
    a = p.parse_args()

    doc = json.loads(a.groups.read_text())
    rows = doc["groups"]
    label = np.array([r["label"] for r in rows])
    train = np.isin(label, ["graded", "background"])
    y = (label[train] == "graded").astype(float)
    print(f"{len(rows):,} groups: {int(y.sum())} graded, {int((y == 0).sum()):,} background, "
          f"{int((label == 'zero_star').sum())} zero-star held out")

    print(f"\nunivariate out-of-fold AUC ({FOLDS}-fold):")
    single = {}
    for name, spec in CANDIDATES:
        col = column(rows, name, spec)[train]
        single[name] = cv_auc(col[:, None], y)
        print(f"  {name:18} {single[name]:.3f}")

    # Forward selection on out-of-fold AUC: with 84 positives, more features stop
    # helping quickly, and adding them silently overfits.
    chosen: list[tuple[str, dict]] = []
    best_auc = 0.5
    print("\nforward selection:")
    while len(chosen) < a.max_features:
        options = []
        for name, spec in CANDIDATES:
            if any(n == name for n, _ in chosen):
                continue
            trial = chosen + [(name, spec)]
            X = np.column_stack([column(rows, n, s)[train] for n, s in trial])
            options.append((cv_auc(X, y), name, spec))
        options.sort(reverse=True, key=lambda o: o[0])
        gain = options[0][0] - best_auc
        if gain < 0.002:
            print(f"  stop: best addition {options[0][1]} gains only {gain:+.3f}")
            break
        best_auc, name, spec = options[0]
        chosen.append((name, spec))
        print(f"  + {name:18} out-of-fold AUC {best_auc:.3f}")

    X_all = np.column_stack([column(rows, n, s) for n, s in chosen])
    X = X_all[train]
    mu, sd = X.mean(axis=0), X.std(axis=0) + 1e-9
    w = fit((X - mu) / sd, y)
    prob = 1 / (1 + np.exp(-apply(w, (X_all - mu) / sd)))

    print("\nfitted weights (standardised):")
    print(f"  intercept {w[0]:+.3f}")
    for (name, _), c in zip(chosen, w[1:]):
        print(f"  {name:18} {c:+.3f}")

    pos, bg = prob[train][y == 1], prob[train][y == 0]
    zero = prob[label == "zero_star"]
    a_bg, a_zero = auc(pos, bg), auc(pos, zero)
    print(f"\nAUC vs background {a_bg:.3f} (out-of-fold {best_auc:.3f}) · "
          f"vs zero-star {a_zero:.3f}")
    for k in (50, 100, 250, 500):
        cut = np.sort(prob)[::-1][k - 1]
        print(f"  top {k:4} watercourses hold {int((pos >= cut).sum()):3} of "
              f"{int(y.sum())} graded canyons "
              f"and {int((zero >= cut).sum())} of {len(zero)} zero-star")

    # A calibrated probability is useless to read: with a 0.7% base rate even a
    # fine canyon lands near 1%. Report where a watercourse sits against the
    # logged canyons instead, so 50 means "as canyon-like as the median descent".
    raw = apply(w, (X_all - mu) / sd)
    graded_raw = np.sort(raw[train][y == 1])
    pct = lambda v: np.interp(v, graded_raw, np.linspace(0, 100, len(graded_raw)))
    print("\ngraded canyons on the against-logged scale (0-100 by construction):")
    gp = pct(raw[train][y == 1])
    for q in (5, 10, 25, 50, 75, 95):
        print(f"  p{q:<3} {np.percentile(gp, q):5.1f}")
    print(f"  zero-star median {np.median(pct(prob if False else raw[label == 'zero_star'])):.1f}"
          f" · background median {np.median(pct(raw[train][y == 0])):.1f}")

    print("\nlowest-scoring graded canyons (where the ranking disagrees with people):")
    lo = np.argsort(raw)
    worst = [i for i in lo if label[i] == "graded"][:6]
    for i in worst:
        r = rows[i]
        print(f"  {pct(raw[i]):5.1f}  {r['name'][:24]:25} peak {r['peak_gradient'] * 100:3.0f}% · "
              f"{r['catchment_km']:5.1f} km up · conf {r['confine_max']:3.0f} m · "
              f"{r['steep_drop']:4.0f} m drop · {', '.join(r['logged'])[:28]}")

    for probe in ("Barvick Burn", "Bruar Water", "Keltie Water"):
        for i, r in enumerate(rows):
            if r["name"] == probe:
                print(f"  probe {probe:14} against-logged {pct(raw[i]):5.1f} · "
                      f"rank {int((raw > raw[i]).sum()) + 1} of {len(rows)} · {r['label']}")
                break

    print("\nmost promising watercourses with nothing logged on them:")
    order = np.argsort(-raw)
    shown = 0
    for i in order:
        r = rows[i]
        if r["label"] != "background" or shown >= 15:
            continue
        shown += 1
        print(f"  {pct(raw[i]):5.1f}  {r['name'][:26]:27} "
              f"{r['steep_drop']:4.0f} m in {r['steep_length'] / 1000:4.1f} km · "
              f"peak {r['peak_gradient'] * 100:3.0f}% · {r['catchment_km']:5.1f} km up · "
              f"conf {r['confine_median']:3.0f} m · {r['lat']:.4f},{r['lon']:.4f}")

    (a.out / "group-score.json").write_text(json.dumps({
        "transform": [{"name": n, **s} for n, s in chosen],
        "mean": mu.tolist(),
        "sd": sd.tolist(),
        "weights": w.tolist(),
        "query": doc["query"],
        "auc_vs_background": round(float(a_bg), 3),
        "auc_out_of_fold": round(float(best_auc), 3),
        "auc_vs_zero_star": round(float(a_zero), 3),
        "graded_scores": [round(float(v), 4) for v in graded_raw],
        "fitted_on": {"positive": int(y.sum()), "background": int((y == 0).sum())},
    }))
    print(f"\nwrote {a.out / 'group-score.json'}")


if __name__ == "__main__":
    main()
