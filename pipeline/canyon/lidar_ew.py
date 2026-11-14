"""England and Wales LiDAR: national DTM composites, sampled at 2 m.

England is the Environment Agency composite, published as zipped 5 km GeoTIFF
tiles; its WCS allows roughly one request every ten seconds, so the tiles are
downloaded whole. Wales is one national cloud-optimised GeoTIFF, read over HTTP
range requests at its 2 m overview so both countries sample alike.
"""

from __future__ import annotations

import http.client
import io
import threading
import time
import urllib.error
import urllib.request
import zipfile
from collections import OrderedDict
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path

import numpy as np
import rasterio
from rasterio.io import MemoryFile
from rasterio.windows import Window, from_bounds
from shapely.geometry import Point, box
from shapely.prepared import prep

from .boundary import polygon

ENGLAND = ("https://environment.data.gov.uk/tiles/collections/survey/"
           "lidar_composite_dtm/2022/2/{tile}")
WALES = ("https://dmwproductionblob.blob.core.windows.net/cogs/lidar/"
         "wales_dtm_32bit_cog.tif")
SIZE = 5_000  # metres per tile edge
RES = 2.0
N = int(SIZE / RES)

_LETTERS = "ABCDEFGHJKLMNOPQRSTUVWXYZ"
_BLOCKS = {(0, 0): "S", (1, 0): "T", (0, 1): "N", (1, 1): "O", (0, 2): "H", (1, 2): "J"}


def tile_name(tx: int, ty: int) -> str:
    """EA tile id for the 5 km tile whose SW corner is (tx, ty) * SIZE: NY2005."""
    x, y = tx * SIZE, ty * SIZE
    first = _BLOCKS[(x // 500_000, y // 500_000)]
    col, row = (x % 500_000) // 100_000, (y % 500_000) // 100_000
    second = _LETTERS[(4 - row) * 5 + col]
    return f"{first}{second}{(x % 100_000) // 1000:02d}{(y % 100_000) // 1000:02d}"


# The EA service answers parallel requests with 429s and stalls roughly every
# fifth one, so requests go one at a time, give up early and try again.
_GATE = threading.Semaphore(1)
# GDAL is not safe to call from several threads at once; only the downloads
# run concurrently.
_GDAL = threading.Lock()
_PACE = threading.Lock()
_SPACING = 1.0
_last = 0.0
failed: list[str] = []


def _download(url: str) -> bytes | None:
    """The response body, None for a 404. Raises once the retries run out."""
    global _last
    req = urllib.request.Request(url, headers={"User-Agent": "canyon-finder/1.0"})
    for attempt in range(8):
        with _PACE:
            wait = _last + _SPACING - time.time()
            if wait > 0:
                time.sleep(wait)
            _last = time.time()
        try:
            with _GATE, urllib.request.urlopen(req, timeout=15) as resp:
                return resp.read()
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return None
            time.sleep(30)
        except (urllib.error.URLError, TimeoutError, ConnectionError,
                http.client.HTTPException):
            pass
    raise TimeoutError(url)


def _england(tx: int, ty: int) -> np.ndarray | None:
    name = tile_name(tx, ty)
    try:
        raw = _download(ENGLAND.format(tile=name))
    except TimeoutError:
        # Left unrefined: a later run skips what is done and tries this again.
        failed.append(name)
        return None
    if raw is None:
        return None
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            tif = z.read(next(n for n in z.namelist() if n.lower().endswith(".tif")))
    except (zipfile.BadZipFile, StopIteration):
        # Some tiles are published as an archive with no raster in it.
        return None
    with _GDAL, MemoryFile(tif) as mem, mem.open() as src:
        window = from_bounds(tx * SIZE, ty * SIZE, (tx + 1) * SIZE, (ty + 1) * SIZE,
                             src.transform)
        return src.read(1, window=window, out_shape=(N, N), boundless=True,
                        masked=True).astype(np.float32).filled(np.nan)


class TileSampler:
    """Channel-floor and point samples from 5 km tiles held in memory.

    Same interface as lidar.LidarSampler. Tiles are fetched on a thread pool so
    `prefetch` can warm the ones a later chain needs.
    """

    QUEUE = 8  # downloads in flight before look-ahead stops adding more

    def __init__(self, raw: Path, radius: float = 12.0, keep: int = 120,
                 workers: int = 6) -> None:
        self.radius = radius
        self.keep = keep
        self._england = prep(polygon(raw, ("England",)))
        self._wales = prep(polygon(raw, ("Wales",)))
        self._tiles: OrderedDict[tuple[int, int], Future] = OrderedDict()
        self._pool = ThreadPoolExecutor(workers)
        self._src: rasterio.DatasetReader | None = None
        self._known: dict[tuple[int, int], tuple[bool, bool]] = {}
        self.fetched = 0

    def tile_for(self, x: float, y: float) -> bool:
        return self._sources(int(x) // SIZE, int(y) // SIZE) != (False, False)

    def in_wales(self, x: float, y: float) -> bool:
        return self._wales.contains(Point(x, y))

    def res_of(self, used: list) -> float:
        return RES

    def _sources(self, tx: int, ty: int) -> tuple[bool, bool]:
        """Which countries a tile touches. Main thread only: prepared
        geometries are not safe to query from several threads."""
        if (tx, ty) not in self._known:
            cell = box(tx * SIZE, ty * SIZE, (tx + 1) * SIZE, (ty + 1) * SIZE)
            self._known[tx, ty] = (self._england.intersects(cell),
                                   self._wales.intersects(cell))
        return self._known[tx, ty]

    def _wales_tile(self, tx: int, ty: int) -> np.ndarray | None:
        with _GDAL:
            try:
                if self._src is None:
                    # The 2 m overview: reading it through the full-resolution
                    # dataset is twenty times slower.
                    self._src = rasterio.open(WALES, overview_level=0)
                src = self._src
                inv = ~src.transform
                c0, r0 = (int(round(v)) for v in inv * (tx * SIZE, (ty + 1) * SIZE))
                cols = slice(max(c0, 0), min(c0 + N, src.width))
                rows = slice(max(r0, 0), min(r0 + N, src.height))
                if cols.start >= cols.stop or rows.start >= rows.stop:
                    return None
                grid = np.full((N, N), np.nan, np.float32)
                grid[rows.start - r0: rows.stop - r0, cols.start - c0: cols.stop - c0] = (
                    src.read(1, window=Window.from_slices(rows, cols), masked=True)
                    .astype(np.float32).filled(np.nan))
                return grid
            except rasterio.RasterioIOError:
                return None

    def _fetch(self, tx: int, ty: int, england: bool, wales: bool) -> np.ndarray | None:
        grid = self._wales_tile(tx, ty) if wales else None
        if england and (grid is None or np.isnan(grid).any()):
            other = _england(tx, ty)
            if other is not None:
                grid = other if grid is None else np.where(np.isnan(grid), other, grid)
        self.fetched += 1
        return grid

    def _tile(self, key: tuple[int, int]) -> Future:
        if key in self._tiles:
            self._tiles.move_to_end(key)
        else:
            self._tiles[key] = self._pool.submit(self._fetch, *key, *self._sources(*key))
            while len(self._tiles) > self.keep:
                self._tiles.popitem(last=False)
        return self._tiles[key]

    def prefetch(self, xs: np.ndarray, ys: np.ndarray, margin: float = 120.0) -> None:
        """Start fetching every tile within `margin` of these points.

        Does nothing while downloads are already queued: a long river spans
        dozens of tiles, and queueing more than the cache holds only fetches
        tiles to throw them away.
        """
        if sum(not f.done() for f in self._tiles.values()) >= self.QUEUE:
            return
        keys = set()
        for dx in (-margin, margin):
            for dy in (-margin, margin):
                keys.update(zip(((xs + dx) // SIZE).astype(int).tolist(),
                                ((ys + dy) // SIZE).astype(int).tolist()))
        for key in keys:
            if self._sources(*key) != (False, False):
                self._tile(key)

    def sample(self, xs: np.ndarray, ys: np.ndarray,
               radius: float | None = None) -> tuple[np.ndarray, list]:
        """Returns (elevations with NaN where uncovered, tiles used).

        `radius` is the channel-floor search; 0 is a plain point sample.
        """
        if radius is None:
            radius = self.radius
        r = int(round(radius / RES))
        out = np.full(xs.shape, np.nan, dtype=np.float32)
        tx = (xs // SIZE).astype(int)
        ty = (ys // SIZE).astype(int)
        used = []
        for key in set(zip(tx.tolist(), ty.tolist())):
            if self._sources(*key) == (False, False):
                continue
            grid = self._tile(key).result()
            if grid is None:
                continue
            used.append(key)
            at = np.flatnonzero((tx == key[0]) & (ty == key[1]))
            col = np.clip(((xs[at] - key[0] * SIZE) / RES).astype(int), 0, N - 1)
            row = np.clip((((key[1] + 1) * SIZE - ys[at]) / RES).astype(int), 0, N - 1)
            if r == 0:
                out[at] = grid[row, col]
                continue
            for i, c, w in zip(at, col, row):
                sub = grid[max(0, w - r): w + r + 1, max(0, c - r): c + r + 1]
                if np.isfinite(sub).any():
                    out[i] = np.nanmin(sub)
        return out, used

    def close(self) -> None:
        self._pool.shutdown(wait=False, cancel_futures=True)
        self._tiles.clear()
