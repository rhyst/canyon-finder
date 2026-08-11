"""Elevation sampling from OS Terrain 50 ASCII grid tiles, with optional LiDAR overlay."""

from __future__ import annotations

import re
import zipfile
from dataclasses import dataclass
from pathlib import Path

import numpy as np

TILE = 10_000  # metres per Terrain 50 tile
CELL = 50.0  # metres per cell
N = 200  # cells per tile edge
NODATA = -32768

SQUARE_RE = re.compile(r"^([a-z]{2})(\d)(\d)_", re.I)

# BNG 100km square letters -> (easting, northing) of square origin
_FIRST = "SNHT"  # 500km blocks: S=(0,0) N=(0,1000km) H=(0,2000km) T=(500km,0)
_LETTERS = "ABCDEFGHJKLMNOPQRSTUVWXYZ"


def square_origin(sq: str) -> tuple[int, int]:
    sq = sq.upper()
    blocks = {"S": (0, 0), "T": (500_000, 0), "N": (0, 500_000), "O": (500_000, 500_000),
              "H": (0, 1_000_000), "J": (500_000, 1_000_000)}
    bx, by = blocks[sq[0]]
    i = _LETTERS.index(sq[1])
    return bx + (i % 5) * 100_000, by + (4 - i // 5) * 100_000


@dataclass
class Terrain50:
    """All loaded 10km tiles, keyed by (tile_x, tile_y) in tile units."""

    tiles: dict[tuple[int, int], np.ndarray]

    @classmethod
    def load(cls, root: Path, squares: set[str], cache: Path | None = None) -> "Terrain50":
        if cache and cache.exists():
            npz = np.load(cache)
            keys = npz["keys"]
            data = npz["data"]
            return cls({(int(k[0]), int(k[1])): data[i] for i, k in enumerate(keys)})

        tiles: dict[tuple[int, int], np.ndarray] = {}
        for sq in sorted(squares):
            d = root / "data" / sq.lower()
            if not d.is_dir():
                continue
            for zpath in sorted(d.glob("*.zip")):
                m = SQUARE_RE.match(zpath.name)
                if not m:
                    continue
                sq_name, ex, ny = m.group(1), int(m.group(2)), int(m.group(3))
                ox, oy = square_origin(sq_name)
                key = ((ox + ex * TILE) // TILE, (oy + ny * TILE) // TILE)
                with zipfile.ZipFile(zpath) as z:
                    name = next(n for n in z.namelist() if n.lower().endswith(".asc"))
                    tiles[key] = _read_asc(z.read(name))
        result = cls(tiles)
        if cache:
            keys = np.array(list(tiles.keys()), dtype=np.int32)
            data = np.stack([tiles[tuple(k)] for k in keys])
            cache.parent.mkdir(parents=True, exist_ok=True)
            np.savez_compressed(cache, keys=keys, data=data)
        return result

    def sample(self, x: np.ndarray, y: np.ndarray) -> np.ndarray:
        """Bilinear elevation (metres, float32) at BNG coords. NaN outside coverage."""
        out = np.full(x.shape, np.nan, dtype=np.float32)
        # Cell centres sit at tile_origin + (i+0.5)*CELL. Work in fractional cell space.
        gx = x / CELL - 0.5
        gy = y / CELL - 0.5
        ix = np.floor(gx).astype(np.int64)
        iy = np.floor(gy).astype(np.int64)
        fx = (gx - ix).astype(np.float32)
        fy = (gy - iy).astype(np.float32)

        z00 = self._at(ix, iy)
        z10 = self._at(ix + 1, iy)
        z01 = self._at(ix, iy + 1)
        z11 = self._at(ix + 1, iy + 1)
        z = (z00 * (1 - fx) * (1 - fy) + z10 * fx * (1 - fy)
             + z01 * (1 - fx) * fy + z11 * fx * fy)
        ok = np.isfinite(z00) & np.isfinite(z10) & np.isfinite(z01) & np.isfinite(z11)
        # Coastal fringe: fall back to nearest valid corner rather than dropping the sample.
        stack = np.stack([z00, z10, z01, z11])
        partial = ~ok & np.isfinite(stack).any(axis=0)
        out[ok] = z[ok]
        if partial.any():
            out[partial] = np.nanmean(stack[:, partial], axis=0)
        return out

    def _at(self, cx: np.ndarray, cy: np.ndarray) -> np.ndarray:
        """Elevation at integer global cell indices, NaN where absent."""
        tx, ty = np.divmod(cx, N)[0], np.divmod(cy, N)[0]
        lx, ly = cx - tx * N, cy - ty * N
        out = np.full(cx.shape, np.nan, dtype=np.float32)
        for key in np.unique(np.stack([tx, ty]), axis=1).T:
            tile = self.tiles.get((int(key[0]), int(key[1])))
            if tile is None:
                continue
            m = (tx == key[0]) & (ty == key[1])
            # Row 0 of an ASC grid is the northernmost row.
            out[m] = tile[N - 1 - ly[m], lx[m]]
        return out


def _read_asc(raw: bytes) -> np.ndarray:
    lines = raw.split(b"\n")
    hdr: dict[str, float] = {}
    n_hdr = 0
    for line in lines:
        parts = line.split()
        if len(parts) == 2 and not parts[0][:1].isdigit() and parts[0][:1] != b"-":
            hdr[parts[0].decode().lower()] = float(parts[1])
            n_hdr += 1
        else:
            break
    values = np.array(b" ".join(lines[n_hdr:]).split(), dtype=np.float32)
    nrows, ncols = int(hdr["nrows"]), int(hdr["ncols"])
    grid = values[: nrows * ncols].reshape(nrows, ncols)
    nd = hdr.get("nodata_value", -9999.0)
    grid = np.where(grid == nd, np.nan, grid)
    return grid.astype(np.float32)
