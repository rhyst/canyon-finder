"""Scotland outline, used to keep the payload to Scottish watercourses."""

from __future__ import annotations

from pathlib import Path

import shapefile
from pyproj import Transformer
from shapely.geometry import shape
from shapely.ops import transform, unary_union
from shapely.prepared import prep


def scotland_polygon(raw: Path):
    """Scotland as a single polygon in BNG, from Natural Earth map subunits."""
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
    return poly.buffer(2000)


def scotland(raw: Path):
    """Prepared Scotland polygon in BNG, for fast containment tests."""
    return prep(scotland_polygon(raw))
