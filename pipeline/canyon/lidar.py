"""Scottish public sector LiDAR: tile index and channel-floor sampling.

The DTMs are cloud-optimised GeoTIFFs on S3, so tiles are read over HTTP range
requests rather than downloaded.
"""

from __future__ import annotations

import json
import re
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import rasterio
from rasterio.windows import Window

BUCKET = "https://srsp-open-data.s3.eu-west-2.amazonaws.com"
NS = "{http://s3.amazonaws.com/doc/2006-03-01/}"

# Reading COGs over HTTP: keep GDAL from probing the bucket and let it cache.
GDAL_ENV = {
    "GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR",
    "CPL_VSIL_CURL_ALLOWED_EXTENSIONS": ".tif",
    "GDAL_HTTP_VERSION": "2",
    "GDAL_HTTP_MULTIPLEX": "YES",
    "GDAL_CACHEMAX": 512,
    "VSI_CACHE": "TRUE",
    "VSI_CACHE_SIZE": "134217728",
}

# Best resolution and most recent capture first.
DATASETS = [
    "lidar/national-lidar-programme",
    "lidar/phase-6",
    "lidar/phase-5",
    "lidar/phase-4",
    "lidar/phase-3",
    "lidar/orkney-islands-council-23",
    "lidar/phase-2",
    "lidar/phase-1",
]

NAME_RE = re.compile(r"([A-Z]{2})(\d+)([NS][EW])?_(\d+)(CM|M)_DTM", re.I)

_LETTERS = "ABCDEFGHJKLMNOPQRSTUVWXYZ"
_BLOCKS = {"S": (0, 0), "T": (500_000, 0), "N": (0, 500_000),
           "O": (500_000, 500_000), "H": (0, 1_000_000), "J": (500_000, 1_000_000)}


def square_origin(sq: str) -> tuple[int, int]:
    bx, by = _BLOCKS[sq[0].upper()]
    i = _LETTERS.index(sq[1].upper())
    return bx + (i % 5) * 100_000, by + (4 - i // 5) * 100_000


@dataclass
class Tile:
    key: str
    res: float
    minx: float
    miny: float
    size: float

    @property
    def url(self) -> str:
        return f"{BUCKET}/{self.key}"


def parse_tile(key: str) -> Tile | None:
    """Derive extent and resolution from an OS-grid tile filename."""
    m = NAME_RE.search(key.rsplit("/", 1)[-1])
    if not m:
        return None
    sq, digits, quad, res_n, res_unit = m.groups()
    res = float(res_n) / (100 if res_unit.upper() == "CM" else 1)
    ox, oy = square_origin(sq)
    if len(digits) % 2:
        return None
    half = len(digits) // 2
    step = 100_000 // (10 ** half)
    ex = int(digits[:half]) * step
    ny = int(digits[half:]) * step
    size = float(step)
    if quad:
        size = step / 2
        ex += size if quad[1].upper() == "E" else 0
        ny += size if quad[0].upper() == "N" else 0
    return Tile(key, res, ox + ex, oy + ny, size)


def _list_keys(prefix: str) -> list[str]:
    keys: list[str] = []
    token = None
    while True:
        url = f"{BUCKET}/?list-type=2&max-keys=1000&prefix={prefix}"
        if token:
            url += f"&continuation-token={urllib.parse.quote(token, safe='')}"
        with urllib.request.urlopen(url, timeout=60) as resp:
            root = ET.fromstring(resp.read())
        keys += [e.text for e in root.iter(f"{NS}Key") if e.text]
        truncated = root.findtext(f"{NS}IsTruncated") == "true"
        token = root.findtext(f"{NS}NextContinuationToken")
        if not truncated or not token:
            return keys


def build_index(cache: Path) -> list[Tile]:
    """Every published DTM tile, best resolution first. Cached after first call."""
    if cache.exists():
        return [Tile(**t) for t in json.loads(cache.read_text())]
    tiles: list[Tile] = []
    for ds in DATASETS:
        keys = _list_keys(f"{ds}/dtm/")
        got = [t for t in (parse_tile(k) for k in keys if k.endswith(".tif")) if t]
        print(f"  {ds}: {len(got)} tiles")
        tiles += got
    tiles.sort(key=lambda t: (t.res, DATASETS.index(_dataset_of(t.key))))
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps([t.__dict__ for t in tiles]))
    return tiles


def _dataset_of(key: str) -> str:
    return next(d for d in DATASETS if key.startswith(d))


class LidarSampler:
    """Samples the channel floor: the minimum elevation within `radius` of a point.

    OS Open Rivers centrelines are only good to a few tens of metres, so a
    point-sample of a 1 m DTM can land on the gorge wall. Taking the local
    minimum keeps the profile on the water.
    """

    CELL = 1_000  # lookup grid for tile hit-testing

    def __init__(self, tiles: list[Tile], radius: float = 12.0) -> None:
        self.tiles = tiles
        self.by_key = {t.key: t for t in tiles}
        self.radius = radius
        self._open: dict[str, rasterio.DatasetReader] = {}
        # Tiles are already sorted best-first, so the first hit in a cell wins.
        self._grid: dict[tuple[int, int], list[Tile]] = {}
        for t in tiles:
            for cx in range(int(t.minx) // self.CELL,
                            int(t.minx + t.size - 1) // self.CELL + 1):
                for cy in range(int(t.miny) // self.CELL,
                                int(t.miny + t.size - 1) // self.CELL + 1):
                    self._grid.setdefault((cx, cy), []).append(t)

    def tile_for(self, x: float, y: float) -> Tile | None:
        for t in self._grid.get((int(x) // self.CELL, int(y) // self.CELL), ()):
            if t.minx <= x < t.minx + t.size and t.miny <= y < t.miny + t.size:
                return t
        return None

    def sample(self, xs: np.ndarray, ys: np.ndarray) -> tuple[np.ndarray, list[str]]:
        """Returns (elevations with NaN where uncovered, tile keys used)."""
        out = np.full(xs.shape, np.nan, dtype=np.float32)
        used: set[str] = set()
        assign: dict[str, list[int]] = {}
        for i, (x, y) in enumerate(zip(xs, ys)):
            t = self.tile_for(float(x), float(y))
            if t:
                assign.setdefault(t.key, []).append(i)

        for key, idx in assign.items():
            tile = self.by_key[key]
            try:
                src = self._reader(tile)
            except rasterio.RasterioIOError:
                continue
            used.add(key)
            r = int(round(self.radius / tile.res))
            inv = ~src.transform
            pix = []
            for i in idx:
                col, row = inv * (float(xs[i]), float(ys[i]))
                if 0 <= col < src.width and 0 <= row < src.height:
                    pix.append((i, int(col), int(row)))

            # Points follow the stream, so consecutive ones cluster: read one
            # window per cluster instead of one per point.
            for group in self._cluster(pix, self.MAX_WINDOW - 2 * r):
                cols = [p[1] for p in group]
                rows = [p[2] for p in group]
                c0 = max(0, min(cols) - r)
                r0 = max(0, min(rows) - r)
                c1 = min(src.width, max(cols) + r + 1)
                r1 = min(src.height, max(rows) + r + 1)
                block = src.read(1, window=Window(c0, r0, c1 - c0, r1 - r0),
                                 masked=True).filled(np.nan)
                for i, col, row in group:
                    sub = block[max(0, row - r0 - r): row - r0 + r + 1,
                                max(0, col - c0 - r): col - c0 + r + 1]
                    if sub.size and np.isfinite(sub).any():
                        out[i] = float(np.nanmin(sub))
        return out, sorted(used)

    MAX_WINDOW = 2048  # pixels per side of a single read

    @staticmethod
    def _cluster(pix: list[tuple[int, int, int]], span: int):
        """Split points into runs whose pixel bounding box stays within `span`."""
        group: list[tuple[int, int, int]] = []
        lo_c = hi_c = lo_r = hi_r = 0
        for p in pix:
            if not group:
                group, lo_c, hi_c, lo_r, hi_r = [p], p[1], p[1], p[2], p[2]
                continue
            nlo_c, nhi_c = min(lo_c, p[1]), max(hi_c, p[1])
            nlo_r, nhi_r = min(lo_r, p[2]), max(hi_r, p[2])
            if nhi_c - nlo_c <= span and nhi_r - nlo_r <= span:
                group.append(p)
                lo_c, hi_c, lo_r, hi_r = nlo_c, nhi_c, nlo_r, nhi_r
            else:
                yield group
                group, lo_c, hi_c, lo_r, hi_r = [p], p[1], p[1], p[2], p[2]
        if group:
            yield group

    def _reader(self, tile: Tile) -> rasterio.DatasetReader:
        if tile.key not in self._open:
            self._open[tile.key] = rasterio.open(tile.url)
        return self._open[tile.key]

    def close(self) -> None:
        for src in self._open.values():
            src.close()
        self._open.clear()
