"""Per-reach features, including valley confinement sampled off the DEM.

Gradient alone says a stream is steep, not that it runs in a gorge. Confinement
is the missing half: how fast the ground rises away from the channel.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence

import numpy as np

# Elevation at BNG coordinates, NaN where uncovered: Terrain50.sample, or a
# LiDAR point sampler where tiles exist.
Sampler = Callable[[np.ndarray, np.ndarray], np.ndarray]

# Perpendicular offsets, in metres, at which valley-side rise is measured.
RADII = (50.0, 100.0, 200.0)


def tangents(x: np.ndarray, y: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Unit flow direction at each sample, from neighbouring points."""
    dx = np.gradient(x)
    dy = np.gradient(y)
    n = np.hypot(dx, dy)
    n[n == 0] = 1.0
    return dx / n, dy / n


def confinement(sample: Sampler, x: np.ndarray, y: np.ndarray, z: np.ndarray,
                radii: Sequence[float] = RADII) -> dict[float, np.ndarray]:
    """Rise of the lower valley side at each radius, per sample, in metres.

    Taking the *lower* of the two sides is what distinguishes a gorge from a
    stream cut into one hillside: both banks have to climb for it to be enclosed.

    NaN where either bank falls outside the sampler's coverage, so a caller with
    a better figure for that sample can keep it.
    """
    tx, ty = tangents(x, y)
    nx, ny = -ty, tx  # perpendicular
    out: dict[float, np.ndarray] = {}
    for r in radii:
        left = sample(x + nx * r, y + ny * r)
        right = sample(x - nx * r, y - ny * r)
        out[r] = np.minimum(left - z, right - z)
    return out


def reach_features(z: np.ndarray, up: np.ndarray, conf: dict[float, np.ndarray],
                   i: int, j: int, spacing: float) -> dict[str, float]:
    """Summarise the reach [i, j] of a chain."""
    seg = z[i: j + 1]
    length = (j - i) * spacing
    drop = float(seg[0] - seg[-1])
    steps = -np.diff(seg) / spacing  # per-sample gradient, downhill positive
    sub = max(1, int(round(100 / spacing)))
    win100 = ((seg[:-sub] - seg[sub:]) / (sub * spacing)) if len(seg) > sub else np.array([0.0])

    feats = {
        "gradient": drop / length if length else 0.0,
        "length": length,
        "drop": drop,
        "steepest_100m": float(win100.max()) if win100.size else 0.0,
        "steepest_step": float(steps.max()) if steps.size else 0.0,
        # How much of the reach is doing the work: a canyon is a run of steep
        # steps, a hillside burn is one steep step in a slack reach.
        "steep_fraction": float((steps >= 0.15).mean()) if steps.size else 0.0,
        "step_variation": float(steps.std()) if steps.size else 0.0,
        "catchment_km": float(up[i]),
        "top_m": float(seg[0]),
        "bottom_m": float(seg[-1]),
    }
    # Window mean, matching search.ts. The browser filters and scores off a
    # prefix-sum mean, which is what makes the confinement slider free, so the
    # fit has to see the same statistic.
    for r, vals in conf.items():
        feats[f"confine_{int(r)}m"] = float(vals[i: j + 1].mean())
    return feats
