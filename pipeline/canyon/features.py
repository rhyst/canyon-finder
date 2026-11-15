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

