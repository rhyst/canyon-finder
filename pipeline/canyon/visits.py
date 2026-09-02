"""Community visit reports, validated and merged into known.json.

Visits are static files under data/visits/, added by pull request: one
directory per visit, a strict visit.yaml plus images. This stage validates
each visit, snaps its location onto the watercourse profiles with the same
snap the Canyon Log entries use (canyon.known.snap_location — one
implementation, so a visit lands on the same reach as its logged canyon),
and merges the reports into known.json: an existing entry that covers the
same reach grows a visits list, otherwise a new entry with source "visit"
is created. Images are copied to web/public/data/visits/ and served by the
static site — no backend, no database.

The star ratings are labels for the promise-score fit, consumed only behind
--include-visits in canyon.analyse and canyon.rank; the merge itself never
touches scoring. See docs/feature-visits.md for the design and
docs/contributing-visits.md for the contributor guide.
"""

from __future__ import annotations

import argparse
import base64
import datetime
import json
import re
import shutil
from dataclasses import dataclass
from pathlib import Path

import yaml
from pyproj import Transformer
from shapely.geometry import Point

from . import payload
from .boundary import scotland
from .known import SnapFailure, snap_grid, snap_location

IMG_EXTS = {".jpg", ".jpeg", ".png", ".webp"}
IMG_MAX_BYTES = 400 * 1024  # every byte ships to every visitor — cap it
IMG_MAX_COUNT = 6
REQUIRED = ("author", "date", "location", "stars")
OPTIONAL = ("name", "description", "grade", "pitches", "highest_pitch_m",
            "corrections", "images", "links")
CORRECTION_KEYS = ("drop_m", "length_m")  # display-only overrides, values only
ISO_DATE = re.compile(r"\d{4}-\d{2}-\d{2}")


def _is_num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _is_int(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def _nonempty_str(v) -> bool:
    return isinstance(v, str) and bool(v.strip())


@dataclass
class Visit:
    """A validated visit, ready to merge."""

    slug: str
    report: dict  # the object stored in the entry's visits list
    name: str     # suggested entry name; "" means fall back to the watercourse
    lon: float
    lat: float
    dir: Path     # data/visits/<slug>/, for the image copies


def _date(v, errs: list[str]) -> str | None:
    """YAML parses unquoted dates to datetime.date; accept that or a strict ISO string."""
    if isinstance(v, datetime.datetime):
        errs.append(f"date must be YYYY-MM-DD, not a datetime (got {v!r})")
        return None
    if isinstance(v, datetime.date):
        return v.isoformat()
    if isinstance(v, str) and ISO_DATE.fullmatch(v):
        return datetime.date.fromisoformat(v).isoformat()
    errs.append(f"date must be YYYY-MM-DD (got {v!r})")
    return None


def _location(v, errs: list[str], boundary, to_bng) -> tuple[float, float] | None:
    if (not isinstance(v, (list, tuple)) or len(v) != 2
            or not all(_is_num(x) for x in v)):
        errs.append(f"location must be [lon, lat] (got {v!r})")
        return None
    lon, lat = float(v[0]), float(v[1])
    if not (-11.0 <= lon <= 1.5 and 54.0 <= lat <= 61.0):
        errs.append(f"location [{lon}, {lat}] is not in the UK")
        return None
    x, y = to_bng.transform(lon, lat)
    if not boundary.contains(Point(x, y)):
        errs.append(f"location [{lon}, {lat}] is not inside Scotland — "
                    f"is the point wrong?")
        return None
    return lon, lat


def validate_visit(vdir: Path, boundary, to_bng) -> tuple[Visit | None, list[str]]:
    """Strictly validate one visit directory.

    Returns (visit, errors); visit is only meaningful when errors is empty.
    Unknown fields are rejected so a typo in a field name cannot silently
    drop data from a contributor's report.
    """
    errs: list[str] = []
    slug = vdir.name
    ypath = vdir / "visit.yaml"
    if not ypath.is_file():
        return None, [f"{slug}: missing visit.yaml"]
    try:
        doc = yaml.safe_load(ypath.read_text())
    except yaml.YAMLError as e:
        return None, [f"{slug}: visit.yaml is not valid YAML: {e}"]
    if not isinstance(doc, dict):
        return None, [f"{slug}: visit.yaml must be a YAML mapping"]

    unknown = set(doc) - set(REQUIRED) - set(OPTIONAL)
    if unknown:
        errs.append(f"unknown field(s) {', '.join(sorted(unknown))} — "
                    f"template: data/visits/_sample/visit.yaml")
    missing = [f for f in REQUIRED if f not in doc]
    if missing:
        errs.append(f"missing required field(s) "
                    f"{', '.join(repr(m) for m in missing)}")

    name = ""
    date: str | None = None
    lonlat: tuple[float, float] | None = None
    stars: int | None = None
    corrections: dict | None = None
    images: list[dict] | None = None
    links: list[str] | None = None

    if "author" in doc and not _nonempty_str(doc["author"]):
        errs.append(f"author must be a non-empty string (got {doc['author']!r})")
    if "date" in doc:
        date = _date(doc["date"], errs)
    if "location" in doc:
        lonlat = _location(doc["location"], errs, boundary, to_bng)
    if "stars" in doc:
        if not _is_int(doc["stars"]) or not 0 <= doc["stars"] <= 4:
            errs.append(f"stars must be an integer 0-4 (0 = dud, 1-4 = worth it); "
                        f"got {doc['stars']!r}")
        else:
            stars = doc["stars"]

    if "name" in doc and not _nonempty_str(doc["name"]):
        errs.append(f"name must be a non-empty string (got {doc['name']!r})")
    if "description" in doc and not _nonempty_str(doc["description"]):
        errs.append("description must be a non-empty string "
                    f"(got {doc['description']!r})")
    if "grade" in doc and not _nonempty_str(doc["grade"]):
        errs.append(f"grade must be a non-empty string (got {doc['grade']!r})")
    if "pitches" in doc and (not _is_int(doc["pitches"]) or doc["pitches"] < 1):
        errs.append(f"pitches must be an integer >= 1 (got {doc['pitches']!r})")
    if "highest_pitch_m" in doc and (
            not _is_num(doc["highest_pitch_m"]) or doc["highest_pitch_m"] <= 0):
        errs.append("highest_pitch_m must be a positive number "
                    f"(got {doc['highest_pitch_m']!r})")

    if "corrections" in doc:
        c = doc["corrections"]
        if not isinstance(c, dict) or not c:
            errs.append("corrections must be a non-empty mapping over "
                        f"{', '.join(CORRECTION_KEYS)} (got {c!r})")
        else:
            bad = set(c) - set(CORRECTION_KEYS)
            if bad:
                errs.append("corrections: unknown key(s) "
                            f"{', '.join(sorted(bad))} — only "
                            f"{', '.join(CORRECTION_KEYS)} are accepted")
            for k in CORRECTION_KEYS:
                if k in c and (not _is_num(c[k]) or c[k] <= 0):
                    errs.append(f"corrections.{k} must be a positive number "
                                f"(got {c[k]!r})")
            if not bad:
                corrections = {k: c[k] for k in CORRECTION_KEYS if k in c}

    if "images" in doc:
        im = doc["images"]
        if not isinstance(im, list) or not im:
            errs.append("images must be a non-empty list")
        elif len(im) > IMG_MAX_COUNT:
            errs.append(f"images: at most {IMG_MAX_COUNT} per visit (got {len(im)})")
        else:
            seen: set[str] = set()
            out: list[dict] = []
            for n, item in enumerate(im):
                if not isinstance(item, dict) or set(item) - {"file", "caption"}:
                    errs.append(f"images[{n}]: keys must be file (+ optional caption)")
                    continue
                f = item.get("file")
                if (not isinstance(f, str) or not f or "/" in f or "\\" in f
                        or ".." in f):
                    errs.append(f"images[{n}]: file must be a plain filename "
                                f"(got {f!r})")
                    continue
                ext = Path(f).suffix.lower()
                if ext not in IMG_EXTS:
                    errs.append(f"images[{n}]: {f} is not a supported image type — "
                                "use " + "/".join(sorted(e.lstrip(".") for e in IMG_EXTS)))
                    continue
                p = vdir / f
                if not p.is_file():
                    errs.append(f"images[{n}]: {f} not found in {slug}/")
                    continue
                if p.stat().st_size > IMG_MAX_BYTES:
                    errs.append(f"images[{n}]: {f} is {p.stat().st_size // 1024} KB, "
                                f"over the {IMG_MAX_BYTES // 1024} KB cap — resize it")
                    continue
                if f in seen:
                    errs.append(f"images[{n}]: duplicate file {f}")
                    continue
                seen.add(f)
                cap = item.get("caption")
                if cap is not None and not _nonempty_str(cap):
                    errs.append(f"images[{n}]: caption must be a non-empty string")
                    cap = None
                out.append({"file": f, **({"caption": cap} if cap else {}),
                            "url": f"/data/visits/{slug}/{f}"})
            if out:
                images = out

    if "links" in doc:
        lk = doc["links"]
        if not isinstance(lk, list) or not lk:
            errs.append("links must be a non-empty list")
        else:
            urls: list[str] = []
            for n, item in enumerate(lk):
                if not isinstance(item, dict) or set(item) != {"url"}:
                    errs.append(f"links[{n}]: must be {{url: ...}} (got {item!r})")
                    continue
                u = item.get("url")
                if not isinstance(u, str) or not (
                        u.startswith("http://") or u.startswith("https://")):
                    errs.append(f"links[{n}]: url must be http(s) (got {u!r})")
                    continue
                urls.append(u)
            if urls:
                links = urls

    if errs:
        return None, [f"{slug}: {e}" for e in errs]

    report: dict = {"author": doc["author"].strip(), "date": date, "stars": stars}
    if _nonempty_str(doc.get("name", "")):
        name = doc["name"].strip()
        report["name"] = name
    for src, dst in (("description", "description"), ("grade", "grade"),
                     ("pitches", "pitches"), ("highest_pitch_m", "highestPitchM")):
        if src in doc:
            report[dst] = doc[src]
    if corrections:
        report["corrections"] = corrections
    if images:
        report["images"] = images
    if links:
        report["links"] = links
    return Visit(slug, report, name, lonlat[0], lonlat[1], vdir), []


def merge(canyons: list[dict], entries: list[tuple[dict, Visit]]) -> list[dict]:
    """Merge validated visits into the known.json canyons list (pure).

    `entries` is (snapped, visit) with snapped the result of
    canyon.known.snap_location. A visit attaches to an existing entry that
    covers the same reach — same chain, overlapping steepest window — and
    otherwise becomes a new entry of its own with source "visit".

    Idempotent: this stage owns the visits lists and the source "visit"
    entries, so both are dropped from the input first and rebuilt. The
    output keeps the gradient-descending order known.py emits.
    """
    out: list[dict] = []
    for c in canyons:
        if c.get("source") == "visit":
            continue
        if "visits" in c or c.get("source") is not None:
            c = {k: v for k, v in c.items() if k not in ("visits", "source")}
        out.append(c)
    for snapped, v in entries:
        hits = [e for e in out
                if e.get("chain") == snapped["chain"]
                and snapped["i"] <= e.get("j", -1) and snapped["j"] >= e.get("i", 1 << 30)]
        if hits:
            target = max(hits, key=lambda e: min(e["j"], snapped["j"])
                         - max(e["i"], snapped["i"]))
            target.setdefault("visits", []).append(v.report)
        else:
            out.append({
                "name": (v.name or snapped["watercourse"]
                          or f"Visit by {v.report['author']} ({v.report['date']})"),
                "grade": v.report.get("grade", ""),
                # "Visit" is not in analyse's GRADED/REJECTED, so these entries
                # sit in the skipped bucket until --include-visits reads the
                # star labels off their reports.
                "category": "Visit",
                "url": "",
                "note": " ".join((v.report.get("description") or "").split())[:240],
                "lon": v.lon,
                "lat": v.lat,
                "source": "visit",
                **snapped,
                "visits": [v.report],
            })
    out.sort(key=lambda r: -r["gradient"])
    return out


def main() -> None:
    root = Path(__file__).resolve().parents[2]
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--visits", type=Path, default=root / "data" / "visits")
    p.add_argument("--out", type=Path, default=root / "web" / "public" / "data")
    p.add_argument("--raw", type=Path, default=root / "data" / "raw")
    p.add_argument("--min-len", type=float, default=200)
    p.add_argument("--max-len", type=float, default=1200)
    p.add_argument("--max-snap", type=float, default=500)
    p.add_argument("--boundary", type=Path,
                   default=root / "data" / "boundary.scotland.geojson",
                   help="committed cache of the Scotland polygon; rebuilt from "
                        "--raw only when missing")
    p.add_argument("--selftest", action="store_true",
                   help="run the validation/merge fixtures (no data needed)")
    a = p.parse_args()

    if a.selftest:
        selftest()
        return

    if not a.visits.is_dir():
        print(f"no visit directories at {a.visits}; known.json unchanged")
        return
    dirs = sorted(d for d in a.visits.iterdir()
                  if d.is_dir() and not d.name.startswith("_"))

    # The committed cache makes this runnable without the raw data (CI).
    boundary = scotland(a.raw, a.boundary)
    to_bng = Transformer.from_crs(4326, 27700, always_xy=True)

    errors: list[str] = []
    visits: list[Visit] = []
    for d in dirs:
        visit, errs = validate_visit(d, boundary, to_bng)
        errors += errs
        if not errs:
            visits.append(visit)

    pay = payload.load(a.out)
    known = json.loads((a.out / "known.json").read_text())
    payload.require_index(pay.meta, known, "known.json")
    if errors:
        print("visit validation failed:\n  " + "\n  ".join(errors))
        raise SystemExit(1)

    grid = snap_grid(pay)
    entries = []
    for v in visits:
        try:
            s = snap_location(pay, grid, v.lon, v.lat,
                              a.min_len, a.max_len, a.max_snap)
        except SnapFailure as e:
            print(f"  ! {v.slug}: {e} — is the point on a mapped channel? skipped")
            continue
        entries.append((s, v))

    merged = merge(known["canyons"], entries)
    (a.out / "known.json").write_text(json.dumps({
        "source": known["source"],
        "index_id": pay.meta["index_id"],
        "canyons": merged,
    }))
    print(f"wrote {len(merged)} canyons ({len(entries)} visit reports) "
          f"-> {a.out / 'known.json'}")

    pub = a.out / "visits"
    if pub.is_dir():
        for d in pub.iterdir():  # a visit removed in the same PR leaves no images
            if d.is_dir() and d.name not in {v.slug for v in visits}:
                shutil.rmtree(d)
    copied = 0
    for _, v in entries:  # snapped visits only — a skipped one leaves no images
        for im in v.report.get("images", []):
            dst = pub / v.slug
            dst.mkdir(parents=True, exist_ok=True)
            shutil.copy2(v.dir / im["file"], dst / im["file"])
            copied += 1
    if copied:
        print(f"copied {copied} images -> {pub}")
    for s, v in entries:
        print(f"  {v.slug:36} {v.report['stars']} stars  "
              f"{s['gradient'] * 100:5.1f}% {s['watercourse'][:22]}")


def selftest() -> None:
    """Fixture tests for validation and merge. No data files needed."""
    import tempfile
    from shapely.geometry import box
    from shapely.prepared import prep

    checks = 0

    def ok(cond: bool, msg: str) -> None:
        nonlocal checks
        if not cond:
            raise AssertionError(msg)
        checks += 1

    to_bng = Transformer.from_crs(4326, 27700, always_xy=True)
    # A 2 m box around one Scottish point: the in-point passes, London fails.
    x, y = to_bng.transform(-5.4123, 56.8765)
    boundary = prep(box(x - 1, y - 1, x + 1, y + 1))

    PNG_1PX = base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ"
        "AAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==")

    good = """\
author: Test Climber
date: 2026-08-15
location: [-5.4123, 56.8765]
stars: 3
name: Test Burn
description: |
  Two solid abseils, big slab at the bottom.
grade: WS2 A2
pitches: 3
highest_pitch_m: 25
corrections:
  drop_m: 40
  length_m: 320
images:
  - file: top.png
    caption: Approach to the top
  - file: bottom.png
links:
  - url: https://example.org/notes
"""

    def run(yaml_text: str, slug: str = "2026-08-15-test",
            images: dict | None = None):
        with tempfile.TemporaryDirectory() as td:
            d = Path(td) / slug
            d.mkdir()
            (d / "visit.yaml").write_text(yaml_text)
            for f, data in (images or {}).items():
                (d / f).write_bytes(data)
            return validate_visit(d, boundary, to_bng)

    # good: everything optional, two images (one captioned)
    visit, errs = run(good, images={"top.png": PNG_1PX, "bottom.png": PNG_1PX})
    ok(errs == [], f"good visit should validate, got {errs}")
    r = visit.report
    ok(r["author"] == "Test Climber" and r["date"] == "2026-08-15"
       and r["stars"] == 3, f"bad core fields {r}")
    ok(r["name"] == "Test Burn" and r["grade"] == "WS2 A2", f"bad name/grade {r}")
    ok(r["pitches"] == 3 and r["highestPitchM"] == 25, f"bad pitch fields {r}")
    ok(r["corrections"] == {"drop_m": 40, "length_m": 320},
       f"corrections must pass through verbatim, got {r.get('corrections')}")
    ok(r["images"][0] == {"file": "top.png", "caption": "Approach to the top",
                          "url": "/data/visits/2026-08-15-test/top.png"},
       f"bad image[0] {r['images'][0]}")
    ok("caption" not in r["images"][1]
       and r["images"][1]["url"].endswith("bottom.png"), f"bad image[1] {r['images'][1]}")
    ok(r["links"] == ["https://example.org/notes"], f"bad links {r.get('links')}")
    ok(visit.name == "Test Burn", "Visit.name should carry the suggested entry name")

    # good: minimal (required fields only), date as a quoted string
    visit, errs = run("author: A\ndate: '2026-01-02'\n"
                      "location: [-5.4123, 56.8765]\nstars: 0\n")
    ok(errs == [], f"minimal visit should validate, got {errs}")
    ok(visit.report == {"author": "A", "date": "2026-01-02", "stars": 0},
       f"minimal report must be exact, got {visit.report}")

    # missing required field
    _, errs = run(good.replace("author: Test Climber\n", ""))
    ok(any("author" in e for e in errs), f"missing author not caught: {errs}")

    # bad types: stars as string, 3-element location, datetime date
    for text, what in ((good.replace("stars: 3", "stars: '3'"), "stars as string"),
                       (good.replace("location: [-5.4123, 56.8765]",
                                     "location: [-5.4123, 56.8765, 0]"),
                        "3-element location"),
                       (good.replace("date: 2026-08-15",
                                     "date: 2026-08-15 10:30:00"),
                        "datetime date")):
        _, errs = run(text, images={"top.png": PNG_1PX, "bottom.png": PNG_1PX})
        ok(errs, f"{what} not caught: {errs}")

    # bad stars: out of range, non-integer
    for text, what in ((good.replace("stars: 3", "stars: 5"), "stars 5"),
                       (good.replace("stars: 3", "stars: -1"), "stars -1"),
                       (good.replace("stars: 3", "stars: 3.0"), "stars 3.0")):
        _, errs = run(text, images={"top.png": PNG_1PX, "bottom.png": PNG_1PX})
        ok(any("stars" in e for e in errs), f"{what} not caught: {errs}")

    # unknown field
    _, errs = run(good + "exposure: extreme\n",
                  images={"top.png": PNG_1PX, "bottom.png": PNG_1PX})
    ok(any("unknown field" in e and "exposure" in e for e in errs),
       f"unknown field not caught: {errs}")

    # images: missing file, bad type, oversized, too many
    _, errs = run(good.replace("file: bottom.png", "file: missing.png"),
                  images={"top.png": PNG_1PX})
    ok(any("not found" in e for e in errs), f"missing image not caught: {errs}")
    _, errs = run(good.replace("file: bottom.png", "file: sheet.pdf"),
                  images={"top.png": PNG_1PX, "sheet.pdf": b"%PDF"})
    ok(any("supported image type" in e for e in errs),
       f"bad image type not caught: {errs}")
    _, errs = run(good, images={"top.png": PNG_1PX,
                                "bottom.png": b"x" * (401 * 1024)})
    ok(any("cap" in e for e in errs), f"oversized image not caught: {errs}")
    many = "images:\n" + "".join(f"  - file: a{i}.png\n" for i in range(7))
    text = good.split("images:\n")[0] + many + "links:\n  - url: https://e.org\n"
    _, errs = run(text, images={f"a{i}.png": PNG_1PX for i in range(7)})
    ok(any("at most 6" in e for e in errs), f"7 images not caught: {errs}")

    # location inside the UK but outside Scotland
    _, errs = run(good.replace("[-5.4123, 56.8765]", "[-2.5, 54.05]"),
                  images={"top.png": PNG_1PX, "bottom.png": PNG_1PX})
    ok(any("not inside Scotland" in e for e in errs), f"England not rejected: {errs}")

    # corrections: unknown key, negative value
    for text, what in (
            (good.replace("drop_m: 40", "depth_m: 12"), "unknown correction key"),
            (good.replace("drop_m: 40", "drop_m: -4"), "negative correction")):
        _, errs = run(text, images={"top.png": PNG_1PX, "bottom.png": PNG_1PX})
        ok(any("corrections" in e for e in errs), f"{what} not caught: {errs}")

    # ---- merge ----------------------------------------------------------
    base = [{
        "name": "Logged Burn", "grade": "", "category": "Advanced", "url": "",
        "note": "", "watercourse": "Test Burn", "snap_m": 5, "chain": 7,
        "i": 10, "j": 20, "gradient": 0.5, "drop": 100.0, "length": 200.0,
        "dem": "50 m", "lon": -5.4, "lat": 56.8,
        "coords": [[-5.4, 56.8], [-5.39, 56.81]],
    }]

    def vis(slug, stars=2, **over):
        rep = {"author": "T", "date": "2026-01-01", "stars": stars, **over}
        return Visit(slug, rep, rep.get("name", ""), -5.41, 56.87, Path("/x"))

    snapped = {"snap_m": 3, "chain": 7, "i": 15, "j": 25,
               "watercourse": "Test Burn", "gradient": 0.5, "drop": 50.0,
               "length": 200.0, "dem": "50 m", "coords": [[-5.41, 56.87]]}

    # overlapping reach on the same chain -> attaches
    merged = merge(base, [(dict(snapped), vis("2026-01-01-a"))])
    ok(len(merged) == 1 and merged[0].get("visits") ==
       [{"author": "T", "date": "2026-01-01", "stars": 2}],
       f"overlap should attach, got {merged}")

    # different chain -> new source "visit" entry
    snapped2 = dict(snapped, chain=8, watercourse="Other Burn", gradient=0.9)
    merged = merge(base, [(snapped2, vis("2026-01-02-b"))])
    new = [e for e in merged if e.get("source") == "visit"]
    ok(len(new) == 1, f"expected one visit entry, got {len(new)}")
    e = new[0]
    ok(e["name"] == "Other Burn" and e["category"] == "Visit" and e["url"] == ""
       and e["chain"] == 8 and e["i"] == 15 and e["j"] == 25, f"bad visit entry {e}")
    ok(len(merged) == 2 and merged[0]["chain"] == 8 and merged[1]["chain"] == 7,
       "output must be gradient-descending")

    # same chain, disjoint window -> new entry, not attached
    merged = merge(base, [(dict(snapped, i=50, j=60), vis("2026-01-03-c"))])
    ok(len(merged) == 2 and not merged[0].get("visits")
       and merged[1].get("source") == "visit",
       f"disjoint window must not attach, got {merged}")

    # idempotent: a second pass over its own output changes nothing
    once = merge(base, [(dict(snapped), vis("2026-01-01-a")),
                        (snapped2, vis("2026-01-02-b", stars=1))])
    twice = merge(once, [(dict(snapped), vis("2026-01-01-a")),
                         (snapped2, vis("2026-01-02-b", stars=1))])
    ok(once == twice, "merge must be idempotent over its own output")

    # pre-existing visits lists / source entries are dropped and rebuilt
    dirty = [dict(base[0], visits=[{"stale": True}]),
             {"name": "old", "source": "visit", "chain": 9, "i": 1, "j": 2,
              "gradient": 0.1, "visits": [{"stale": True}]}]
    merged = merge(dirty, [(dict(snapped), vis("2026-01-01-a"))])
    ok(all("stale" not in json.dumps(m) for m in merged),
       f"stale visit data survived: {merged}")

    print(f"visits selftest: {checks} checks passed")


if __name__ == "__main__":
    main()
