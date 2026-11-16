"""Rank steep sections by how much they look like a rated canyon.

Fits on the sections exported from the app's own measuring code
(web/tools/export-sections.ts), so the model and the UI cannot drift apart.

Positives are sections holding a Canyon Log descent rated 1 star or more.
Background is every section with nothing logged on it. Sections holding only a
0-star or unrated entry are left out of the fit and reported on: nothing
measured here separates a good canyon from a dull one, so the score is only
asked where the canyons are.

The app shows the score as a rank among all sections, and the capture curve
written here says what a rank is worth: the share of rated canyons found in the
top N% of sections, measured out of fold.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

from . import payload

# Candidate features: fields of the app's Candidate, with the transform used
# before standardising. Where the water term saturates is selected, not assumed.
CANDIDATES: list[tuple[str, dict]] = [
    ("gradient", {}),
    ("steepest", {}),
    ("drop", {"log1p": True}),
    ("length", {"log1p": True}),
    ("catchment", {"log1p": True, "cap": 50.0}),
    ("drain <=10", {"src": "drain", "log1p": True, "cap": 10.0}),
    ("drain <=50", {"src": "drain", "log1p": True, "cap": 50.0}),
    ("drain <=200", {"src": "drain", "log1p": True, "cap": 200.0}),
    ("power", {"log1p": True}),
    ("confine", {"cap": 60.0}),
    ("confineMax", {"cap": 60.0}),
    ("top", {"cap": 900.0}),
    ("drops", {"log1p": True}),
    ("single", {}),
]
FOLDS = 5
GOOD = 1  # stars: 0 is "not worth it", anything rated above is a real canyon
SHARES = (0.01, 0.02, 0.05, 0.10, 0.25, 0.50)
SPLIT_LAT = 55.3  # roughly the border: Scotland against England and Wales


def auc(pos: np.ndarray, neg: np.ndarray) -> float:
    """Probability a random positive scores above a random negative."""
    if not len(pos) or not len(neg):
        return float("nan")
    ranks = np.argsort(np.argsort(np.concatenate([pos, neg]))) + 1
    r_pos = ranks[: len(pos)].sum()
    return (r_pos - len(pos) * (len(pos) + 1) / 2) / (len(pos) * len(neg))


def logistic(X: np.ndarray, y: np.ndarray, iters: int = 40) -> np.ndarray:
    """Newton-Raphson logistic fit. X already has an intercept column."""
    w = np.zeros(X.shape[1])
    for _ in range(iters):
        p = 1 / (1 + np.exp(-X @ w))
        s = p * (1 - p) + 1e-9
        H = X.T @ (X * s[:, None]) + 1e-6 * np.eye(X.shape[1])
        w += np.linalg.solve(H, X.T @ (y - p))
    return w


def column(rows: list[dict], name: str, spec: dict) -> np.ndarray:
    v = np.array([float(r[spec.get("src", name)]) for r in rows])
    if "cap" in spec:
        v = np.minimum(v, spec["cap"])
    if spec.get("log1p"):
        v = np.log1p(np.maximum(v, 0))
    return v


def fit_apply(X: np.ndarray, y: np.ndarray, train: np.ndarray, test: np.ndarray) -> np.ndarray:
    """Scores for `test` rows from a fit on `train` rows."""
    mu, sd = X[train].mean(axis=0), X[train].std(axis=0) + 1e-9
    w = logistic(np.column_stack([np.ones(train.sum()), (X[train] - mu) / sd]), y[train])
    return np.column_stack([np.ones(test.sum()), (X[test] - mu) / sd]) @ w


def out_of_fold(X: np.ndarray, y: np.ndarray, seed: int = 0) -> np.ndarray:
    """A score for every row from a model that never saw it. With this few
    positives, in-sample figures flatter badly."""
    fold = np.random.default_rng(seed).integers(0, FOLDS, len(y))
    scores = np.zeros(len(y))
    for f in range(FOLDS):
        scores[fold == f] = fit_apply(X, y, fold != f, fold == f)
    return scores


def main() -> None:
    root = Path(__file__).resolve().parents[2]
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--sections", type=Path, default=root / "data" / "work" / "sections.json")
    p.add_argument("--out", type=Path, default=root / "web" / "public" / "data")
    p.add_argument("--max-features", type=int, default=5)
    a = p.parse_args()

    doc = json.loads(a.sections.read_text())
    meta = json.loads((a.out / "profiles.json").read_text())
    payload.require_index(meta, doc, a.sections.name)
    every = doc["sections"]
    stars_all = np.array([-1 if r["stars"] is None else r["stars"] for r in every])
    logged_all = np.array([bool(r["logged"]) for r in every])
    use = (stars_all >= GOOD) | ~logged_all
    rows = [r for r, u in zip(every, use) if u]
    y = (stars_all[use] >= GOOD).astype(float)
    print(f"{len(every):,} sections: {int(y.sum())} hold a canyon rated {GOOD}+ stars, "
          f"{int((y == 0).sum()):,} background, {int((~use).sum())} with only a 0-star "
          f"or unrated entry left out")

    def cv(cols: np.ndarray) -> float:
        s = out_of_fold(cols, y)
        return auc(s[y == 1], s[y == 0])

    print(f"\nunivariate out-of-fold AUC ({FOLDS}-fold):")
    for name, spec in CANDIDATES:
        print(f"  {name:14} {cv(column(rows, name, spec)[:, None]):.3f}")

    # Forward selection on out-of-fold AUC: with few positives, more features
    # stop helping quickly, and adding them silently overfits.
    chosen: list[tuple[str, dict]] = []
    best_auc = 0.5
    print("\nforward selection:")
    while len(chosen) < a.max_features:
        taken = {s.get("src", n) for n, s in chosen}
        options = []
        for name, spec in CANDIDATES:
            if spec.get("src", name) in taken:
                continue
            trial = chosen + [(name, spec)]
            options.append((cv(np.column_stack([column(rows, n, s) for n, s in trial])),
                            name, spec))
        # Under a tie take the tighter cap: the looser one fills the top of the
        # list with major rivers carrying no gradient.
        options.sort(reverse=True, key=lambda o: (round(o[0], 3), -o[2].get("cap", 0.0)))
        if options[0][0] - best_auc < 0.002:
            print(f"  stop: best addition {options[0][1]} gains only "
                  f"{options[0][0] - best_auc:+.3f}")
            break
        best_auc, name, spec = options[0]
        chosen.append((name, spec))
        print(f"  + {name:14} out-of-fold AUC {best_auc:.3f}")

    X = np.column_stack([column(rows, n, s) for n, s in chosen])
    mu, sd = X.mean(axis=0), X.std(axis=0) + 1e-9
    w = logistic(np.column_stack([np.ones(len(X)), (X - mu) / sd]), y)
    print("\nfitted weights (standardised):")
    print(f"  intercept {w[0]:+.3f}")
    for (name, _), c in zip(chosen, w[1:]):
        print(f"  {name:14} {c:+.3f}")

    # The honest test for a prospecting tool: fit on one country, find the
    # canyons in another.
    north = np.array([r["lat"] >= SPLIT_LAT for r in rows])
    across = []
    print()
    for train, label in ((north, "fit Scotland, test England+Wales"),
                         (~north, "fit England+Wales, test Scotland")):
        s = fit_apply(X, y, train, ~train)
        across.append(auc(s[y[~train] == 1], s[y[~train] == 0]))
        print(f"  {label}: AUC {across[-1]:.3f} on {int(y[~train].sum())} canyons")

    oof = out_of_fold(X, y)
    order = np.sort(oof)[::-1]
    capture = []
    print("\nwhat a rank is worth, out of fold:")
    for share in SHARES:
        cut = order[max(int(share * len(order)) - 1, 0)]
        held = float((oof[y == 1] >= cut).mean())
        capture.append([share, round(held, 3)])
        print(f"  top {share * 100:4.0f}% of sections hold {held * 100:3.0f}% of rated canyons")

    Xa = np.column_stack([column(every, n, s) for n, s in chosen])
    raw = np.column_stack([np.ones(len(Xa)), (Xa - mu) / sd]) @ w
    rank = (np.argsort(np.argsort(-raw)) + 1) / len(raw)
    print("\nmedian rank by rating: " + " · ".join(
        f"{s}★ top {np.median(rank[stars_all == s]) * 100:.0f}%"
        for s in range(5) if (stars_all == s).any())
        + f" · unrated logged top {np.median(rank[logged_all & (stars_all < 0)]) * 100:.0f}%")

    print("\nlowest-ranked rated canyons (where the ranking disagrees with people):")
    low = [i for i in np.argsort(raw) if stars_all[i] >= GOOD][:6]
    for i in low:
        r = every[i]
        print(f"  top {rank[i] * 100:3.0f}%  {r['name'][:22]:23} {r['gradient'] * 100:3.0f}% · "
              f"{r['drop']:4.0f} m · {r['drain']:5.1f} km² · conf {r['confine']:3.0f} m · "
              f"{', '.join(r['logged'])[:30]}")

    print("\nbest-ranked sections with nothing logged on them:")
    shown = 0
    for i in np.argsort(-raw):
        r = every[i]
        if r["logged"] or shown >= 15:
            continue
        shown += 1
        print(f"  {r['name'][:26]:27} {r['drop']:4.0f} m in {r['length'] / 1000:4.2f} km · "
              f"{r['gradient'] * 100:3.0f}% · {r['drain']:6.1f} km² · conf {r['confine']:3.0f} m · "
              f"{r['lat']:.4f},{r['lon']:.4f}")

    pos = [r for r, s in zip(every, stars_all) if s >= GOOD]
    med = lambda k: float(np.median([r[k] for r in pos]))
    badges = {
        "gradient": round(med("gradient"), 3),
        "drop": round(med("drop")),
        "confine": round(med("confine")),
        "drops": round(med("drops")),
        "water": [round(float(v), 1) for v in
                  np.percentile([r["drain"] for r in pos], [10, 90])],
    }
    print(f"\nbadge thresholds: {badges}")

    (a.out / "score.json").write_text(json.dumps({
        "index_id": doc["index_id"],
        "transform": [{**{k: v for k, v in s.items() if k != "src"},
                       "name": s.get("src", n)} for n, s in chosen],
        "mean": mu.tolist(),
        "sd": sd.tolist(),
        "weights": w.tolist(),
        "capture": capture,
        "badges": badges,
        "auc_out_of_fold": round(float(best_auc), 3),
        "auc_other_region": round(float(np.mean(across)), 3),
        "fitted_on": {"positive": int(y.sum()), "background": int((y == 0).sum())},
    }))
    print(f"\nwrote {a.out / 'score.json'}")


if __name__ == "__main__":
    main()
