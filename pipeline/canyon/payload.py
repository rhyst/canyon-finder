"""The binary the browser searches: read it, write it, know its layout.

One record per profile sample, in parallel arrays, plus a chain index in
profiles.json. Fixed 25 m spacing is what lets the browser treat a window length
as a sample count, so nothing here stores distance.

Layout, after a 16-byte header:

    z       int16   decimetres
    up      uint16  0.1 km of upstream watercourse
    dlon    int16   1e-7 deg, delta between quantised positions
    dlat    int16
    ddrain  uint16  delta of sqrt(km2) * DRAIN_SCALE, see quantise_drain
    conf    uint8   metres of valley-side rise 100 m out

The uint8 array goes last so that an odd sample count cannot misalign the
int16s. Adding an array means bumping MAGIC, because a browser holding the old
format would read the new bytes as the wrong thing rather than fail.
"""

from __future__ import annotations

import json
import struct
from dataclasses import dataclass
from pathlib import Path

import numpy as np

MAGIC = b"CNY4"
# Drainage area is held as fixed point on its square root: uint16 covers the
# 5,000 km2 of the Tay while still resolving 0.004 km2 around 1 km2, which a
# linear scale cannot do in two bytes. Stored as deltas, which are zero for most
# samples and so cost almost nothing once gzipped.
DRAIN_SCALE = 500.0


@dataclass
class Payload:
    """Every array in profiles.bin, plus the chain index from profiles.json."""

    meta: dict
    z: np.ndarray
    up: np.ndarray
    drain: np.ndarray  # km², decoded
    conf: np.ndarray
    dlon: np.ndarray
    dlat: np.ndarray
    spacing: float

    @property
    def total(self) -> int:
        return len(self.z)

    @property
    def chains(self) -> list[dict]:
        return self.meta["chains"]

    def chain(self, c: dict) -> slice:
        return slice(c["o"], c["o"] + c["n"])


def quantise_drain(area: np.ndarray) -> np.ndarray:
    """Drainage area in km² to the stored fixed point on its square root."""
    q = np.round(np.sqrt(np.maximum(area, 0.0)) * DRAIN_SCALE)
    return np.minimum(q, 65535).astype(np.int64)


def load(out: Path) -> Payload:
    meta = json.loads((out / "profiles.json").read_text())
    raw = (out / "profiles.bin").read_bytes()
    magic, total, n_chains, spacing = struct.unpack_from("<4sIII", raw, 0)
    if magic != MAGIC:
        raise SystemExit(f"payload is {magic.decode()}, this build reads "
                         f"{MAGIC.decode()} — rerun python -m canyon.build")

    def take(dtype: str, offset: int) -> np.ndarray:
        return np.frombuffer(raw, dtype, count=total, offset=offset).copy()

    off = 16
    z = take("<i2", off)
    up = take("<u2", off + total * 2)
    dlon = take("<i2", off + total * 4)
    dlat = take("<i2", off + total * 6)
    ddrain = take("<u2", off + total * 8)
    conf = take("u1", off + total * 10)

    # Deltas are per chain, so each restarts from its own stored origin.
    drain = np.zeros(total, np.float64)
    for c in meta["chains"]:
        s = slice(c["o"], c["o"] + c["n"])
        q = c.get("drain0", 0) + np.cumsum(ddrain[s].astype(np.int64))
        drain[s] = (q / DRAIN_SCALE) ** 2

    return Payload(meta, z, up, drain.astype(np.float32), conf, dlon, dlat,
                   float(spacing))


def save(out: Path, p: Payload) -> None:
    total = p.total
    q = quantise_drain(p.drain)
    ddrain = np.zeros(total, np.uint16)
    for c in p.chains:
        s = slice(c["o"], c["o"] + c["n"])
        qc = np.maximum.accumulate(q[s])  # deltas must not go negative
        ddrain[s] = np.diff(qc, prepend=qc[0]).astype(np.uint16)
        c["drain0"] = int(qc[0])

    with (out / "profiles.bin").open("wb") as f:
        f.write(struct.pack("<4sIII", MAGIC, total, len(p.chains), int(p.spacing)))
        f.write(p.z.astype(np.int16).tobytes())
        f.write(p.up.astype(np.uint16).tobytes())
        f.write(p.dlon.astype(np.int16).tobytes())
        f.write(p.dlat.astype(np.int16).tobytes())
        f.write(ddrain.tobytes())
        f.write(p.conf.astype(np.uint8).tobytes())
    (out / "profiles.json").write_text(json.dumps(p.meta))


def chain_lonlat(c: dict, dlon: np.ndarray, dlat: np.ndarray):
    """Reconstruct a chain's coordinates from its stored deltas."""
    s = slice(c["o"], c["o"] + c["n"])
    lon = (c["lon0"] + np.cumsum(dlon[s].astype(np.int64)) - int(dlon[s][0])) / 1e7
    lat = (c["lat0"] + np.cumsum(dlat[s].astype(np.int64)) - int(dlat[s][0])) / 1e7
    return lon, lat
