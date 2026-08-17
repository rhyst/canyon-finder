"""Known Scottish descents from Canyon Log, snapped onto our watercourse profiles.

Canyon Log (https://canyonlog.org/map/) publishes community-logged canyons as
point markers. This pulls the Scottish ones, matches each to the watercourse it
sits on, and measures the reach around it with the same profile data the search
uses — so a logged canyon can be drawn as a line and compared with candidates
on equal terms.

The result is cached in the payload for personal reference; Canyon Log states no
licence, so credit it in anything you publish and ask before redistributing.
"""

from __future__ import annotations

import argparse
import json
import re
import urllib.request
from pathlib import Path

import numpy as np
from pyproj import Transformer
from shapely.geometry import Point

from .boundary import scotland
from . import payload
from .payload import chain_lonlat

SOURCE = "https://canyonlog.org/wp-json/mapster-wp-maps/map?id=17437"
GRADE_RE = re.compile(r"Grade:\s*([^<\n]+)")
TAG_RE = re.compile(r"<[^>]+>")


def fetch(cache: Path, refresh: bool = False, url: str = SOURCE) -> list[dict]:
    """Canyon Log's map data, cached on first fetch.

    Rebuilding the payload renumbers its chains, so this has to run again every
    time — see canyon.payload.index_id. That is no reason to pull someone else's
    site each time: it is cached like the LiDAR index and the gauging stations,
    and --refresh is there when the logs have actually changed.
    """
    if cache.exists() and not refresh:
        return json.loads(cache.read_text())["locations"]
    req = urllib.request.Request(url, headers={"User-Agent": "canyon-finder/1.0"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        raw = resp.read()
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_bytes(raw)
    return json.loads(raw)["locations"]


def parse(loc: dict) -> dict | None:
    geom = loc.get("data", {}).get("location") or {}
    if geom.get("type") != "Point":
        return None
    lon, lat = geom["coordinates"][:2]
    body = loc.get("data", {}).get("popup", {}).get("body_text", "") or ""
    grade = GRADE_RE.search(body)
    text = TAG_RE.sub(" ", body)
    return {
        "name": loc.get("title", "").strip(),
        "lon": float(lon),
        "lat": float(lat),
        "grade": (grade.group(1).strip() if grade else ""),
        "category": "; ".join(c["name"] for c in loc.get("categories", [])),
        "url": loc.get("permalink", ""),
        "note": " ".join(text.split())[:240],
    }


def best_reach(z: np.ndarray, hit: int, spacing: float,
               min_len: float, max_len: float) -> tuple[int, int, float]:
    """Steepest window containing `hit`, within the length band."""
    lo = max(1, int(round(min_len / spacing)))
    hi = max(lo, int(round(max_len / spacing)))
    best = (hit, min(hit + lo, len(z) - 1), 0.0)
    for k in range(lo, hi + 1):
        for i in range(max(0, hit - k), min(hit + 1, len(z) - k)):
            g = (z[i] - z[i + k]) / (k * spacing)
            if g > best[2]:
                best = (i, i + k, float(g))
    return best


def main() -> None:
    root = Path(__file__).resolve().parents[2]
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--out", type=Path, default=root / "web" / "public" / "data")
    p.add_argument("--raw", type=Path, default=root / "data" / "raw")
    p.add_argument("--work", type=Path, default=root / "data" / "work")
    p.add_argument("--refresh", action="store_true",
                   help="re-fetch Canyon Log instead of using the cache")
    p.add_argument("--min-len", type=float, default=200)
    p.add_argument("--max-len", type=float, default=1200)
    p.add_argument("--max-snap", type=float, default=500,
                   help="give up if no watercourse sample is this close, in metres")
    a = p.parse_args()

    locations = [r for r in (parse(l) for l in
                             fetch(a.work / "canyonlog.json", a.refresh)) if r]
    print(f"Canyon Log: {len(locations)} logged canyons worldwide")

    scot = scotland(a.raw)
    to_bng = Transformer.from_crs(4326, 27700, always_xy=True)
    inside = []
    for r in locations:
        x, y = to_bng.transform(r["lon"], r["lat"])
        if scot.contains(Point(x, y)):
            inside.append(r)
    print(f"  {len(inside)} in Scotland")

    pay = payload.load(a.out)
    meta, total, spacing = pay.meta, pay.total, pay.spacing
    lon_all = np.empty(total)
    lat_all = np.empty(total)
    chain_of = np.empty(total, dtype=np.int32)
    for ci, c in enumerate(meta["chains"]):
        lo, la = chain_lonlat(c, pay.dlon, pay.dlat)
        s = slice(c["o"], c["o"] + c["n"])
        lon_all[s], lat_all[s], chain_of[s] = lo, la, ci

    out = []
    for r in inside:
        scale = np.cos(np.radians(r["lat"]))
        d = np.hypot((lon_all - r["lon"]) * scale * 111_320, (lat_all - r["lat"]) * 110_540)
        idx = int(np.argmin(d))
        snap = float(d[idx])
        if snap > a.max_snap:
            print(f"  ! {r['name']}: nearest watercourse {snap:.0f} m away, skipped")
            continue
        ci = int(chain_of[idx])
        c = meta["chains"][ci]
        zc = pay.z[pay.chain(c)].astype(np.float32) / 10
        hit = idx - c["o"]
        i, j, grad = best_reach(zc, hit, spacing, a.min_len, a.max_len)
        lo, la = chain_lonlat(c, pay.dlon, pay.dlat)
        out.append({
            **r,
            "snap_m": round(snap),
            "chain": ci,
            "i": i,
            "j": j,
            # The run name at the window start, not the chain's dominant name:
            # a chain changes name mid-course (Burn of Sorrow -> Dollar Burn at
            # the confluence), and the app groups reaches per-run, so the chain
            # name ties a logged canyon to a stretch it does not sit on.
            "watercourse": payload.name_at(c, i),
            "gradient": round(grad, 4),
            "drop": round(float(zc[i] - zc[j]), 1),
            "length": (j - i) * spacing,
            "dem": c.get("dem", "50 m"),
            "coords": [[round(float(lo[k]), 6), round(float(la[k]), 6)]
                       for k in range(i, j + 1)],
        })

    out.sort(key=lambda r: -r["gradient"])
    (a.out / "known.json").write_text(json.dumps({
        "source": "Canyon Log — https://canyonlog.org/map/",
        "index_id": pay.meta["index_id"],
        "canyons": out,
    }))
    print(f"wrote {len(out)} snapped canyons -> {a.out / 'known.json'}")
    for r in out[:12]:
        print(f"  {r['name'][:30]:30} {r['gradient'] * 100:5.1f}% "
              f"{r['drop']:5.0f}m/{r['length']:.0f}m  snap {r['snap_m']:3d}m  "
              f"{r['watercourse'][:22]}")


if __name__ == "__main__":
    main()
