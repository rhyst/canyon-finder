"""Scotland outline, used to keep the payload to Scottish watercourses."""

from __future__ import annotations

import json
from pathlib import Path

import shapefile
from pyproj import Transformer
from shapely.geometry import shape
from shapely.ops import transform, unary_union
from shapely.prepared import prep


def scotland_polygon(raw: Path, cache: Path | None = None):
    """Scotland as a single polygon in BNG, from Natural Earth map subunits.

    Natural Earth is a fixed public dataset, so the compiled polygon is
    cached at `cache` — a small file committed to the repo. Stages that only
    need the boundary, like the visits stage in CI, never have the ~215 MB
    of raw data and read the cache instead. The cache is written only when
    missing; refresh it by deleting the file and re-running from a checkout
    that has data/raw/ (fetch.sh gets the shapefile).
    """
    if cache is not None and cache.exists():
        return shape(json.loads(cache.read_text()))
    shp = raw / "ne_subunits" / "ne_10m_admin_0_map_subunits.shp"
    reader = shapefile.Reader(str(shp))
    fields = [f[0] for f in reader.fields[1:]]
    geoms = []
    for rec in reader.iterShapeRecords():
        attrs = dict(zip(fields, rec.record))
        if attrs.get("GEOUNIT") == "Scotland":
            geoms.append(shape(rec.shape.__geo_interface__))
    if not geoms:
        raise RuntimeError("Scotland not found in Natural Earth subunits")
    to_bng = Transformer.from_crs(4326, 27700, always_xy=True).transform
    poly = transform(to_bng, unary_union(geoms))
    # Natural Earth is 1:10m: buffer out so coastal and border detail is not lost.
    poly = poly.buffer(2000)
    if cache is not None:
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps(poly.__geo_interface__))
    return poly


def scotland(raw: Path, cache: Path | None = None):
    """Prepared Scotland polygon in BNG, for fast containment tests."""
    return prep(scotland_polygon(raw, cache))
