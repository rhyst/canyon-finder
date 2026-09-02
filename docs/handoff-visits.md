# Handoff — community visit records

**Status:** M1 done (stage, validation, selftest, CI, docs). M2–M4 next.
Design and rationale: `docs/feature-visits.md` (read that first). This doc is
the working brief: what to build, where the code lives, and the traps.

## Goal

Let people record visits to prospective canyons by adding static files in a
pull request. A pipeline stage validates and snaps them onto the watercourse
profiles and merges them into `known.json`; the app shows the reports (map,
list, detail panel with images); the promise-score fitters gain a gated way to
use them as labels.

## Locked decisions (do not re-litigate)

1. **Rating:** `stars: 0-4` integer, Canyon Log vocabulary — `0` = dud,
   `1-4` = worth it. Fit consumes binary (0 vs 1+); raw value retained.
2. **Fit:** built now behind `--include-visits` (off by default) on
   `analyse` and `rank`. Flip + re-fit + commit score files only when ~5
   visits exist (milestone M4).
3. **Corrections:** values only (`drop_m`, `length_m`) in v1. Display-only —
   search and fit never read them. Reach-window correction is deferred.
4. **Merge target:** visits go **into** `web/public/data/known.json` (attach
   to an existing snapped entry or new entry with `source: "visit"`), not a
   separate `visits.json`.
5. **Format:** one directory per visit, YAML. `pyyaml` joins the pipeline deps.

## Where things live (verified references)

### Pipeline (python, `pipeline/canyon/`)
- `known.py` — the model to follow. `best_reach(z, hit, spacing, min_len,
  max_len) -> (i, j, gradient)` at line 71 (steepest window in the 200–1200 m
  band containing the snap point). The lon/lat → (chain, i, j) snapping loop
  lives inside `main()` (lines ~95–155): build `lon_all`/`lat_all`/`chain_of`
  from `meta["chains"]`, `np.hypot` nearest-sample, give up past `--max-snap`
  500 m, then emit the entry dict. **Refactor that loop into an importable
  `snap_location(...)` helper and share it with the new stage** — do not copy
  it.
- `payload.py` — `require_index(meta, doc, name)` at line 59 (stale-artifact
  guard; every emitted JSON records `index_id`), `chain_lonlat` line 153,
  `name_at(chain, i)` line 161. The order line in `require_index`'s error
  message (line ~67) and the one in `build`'s docstring must gain `visits`
  after `known`.
- `analyse.py` — reach-level score. Label logic at lines 67–75: entries whose
  `category` is in `GRADED = {"Basic", "Moderate", "Advanced"}` (line 26) are
  positives; `REJECTED = {"0 Stars"}` (line 27) are held-out negatives;
  anything else is skipped and counted (lines 74–75). M3 adds: with
  `--include-visits`, an entry with `visits` reports joins positive/negative
  by star labels. Print the visit count so the M4 gate is visible.
- `rank.py` — watercourse-level ranking, same scheme on groups
  (`--groups`, `--out`, `--max-features` args; main at line 83).
- `boundary.scotland` — the in-Scotland check (`known.py` uses it via
  `shapely`).
- Pipeline order today: `build -> refine -> watershed -> known -> analyse ->
  export-groups -> rank`. It becomes `... -> known -> visits -> analyse -> ...`.

### Web (typescript, `web/src/`)
- `types.ts` — `KnownCanyon` at line 84. Add optional `source?:
  'canyon-log' | 'visit'` and `visits?: VisitReport[]` (see schema below).
- `canyonlog.ts` — 35 lines; `isDud` (category === ZERO_STAR), `isGraded`,
  `covered()`. Extend `isDud` (visit entries: all reports `stars === 0`) and
  add `isWorthwhile`. **Everything downstream keys off these two:** map layer
  styling, the graded/dud counters, `knownByChain` in main.ts (line 123).
- `main.ts` (973 lines) — known load at 355–390 (note the `fresh()`
  index-staleness check at 380: a stale `known.json` is dropped wholesale —
  your merge must keep `index_id` correct or the app silently ignores it).
  `selectKnown` at ~line 732 builds the detail panel via `showDetail`
  (interface `Detail` at ~line 768: `title`, `stats`, `extra` html). Visit
  reports render below `stats`; description text must go through `esc()`
  (`format.ts`) and links through `safeUrl()`.
- `format.ts` — `esc`, `safeUrl` (http/https only).
- Tests: `web/test/search.test.ts` is the pattern — plain node
  (`node --experimental-strip-types`), reads the real committed payloads from
  `public/data/`. Add `web/test/visits.test.ts` alongside.

### Ops
- `mise.toml` — add `pipeline:visits` task mirroring `pipeline:known`
  (`dir = "pipeline"`, `run = "uv run python -m canyon.visits"`).
- `.github/workflows/deploy.yml` — the existing Pages workflow; **leave it
  alone** (it never runs the pipeline). New `visits.yml` beside it.
- `pipeline/pyproject.toml` — add `pyyaml` to dependencies.
- Committed artifacts in `web/public/data/`: `profiles.bin`, `profiles.json`,
  `known.json`, `score.json`, `group-score.json`, `lidar.json`. `known.json`
  shape: `{source, index_id, canyons: [...]}`; each canyon has
  `name, grade, category, url, note, snap_m, chain, i, j, watercourse,
  gradient, drop, length, dem, coords, lon, lat`.

## Schema (verbatim contract)

`data/visits/<YYYY-MM-DD-kebab-slug>/visit.yaml`:

```yaml
# required
author: Rhys
date: 2026-08-15
location: [-5.4123, 56.8765]   # [lon, lat], nearest point on the canyon
stars: 3                       # 0 = dud, 1-4 = worth it

# optional
name: Allt Arrifish
description: |
  Two solid abseils, big slab at the bottom.
grade: WS2 A2                  # free text
pitches: 3
highest_pitch_m: 25
corrections:                   # display-only overrides
  drop_m: 40
  length_m: 320
images:
  - file: top.jpg
    caption: Approach to the top
links:
  - url: https://example.org/notes
```

Emerged report object inside `known.json` entries:
`{author, date, stars, description?, grade?, pitches?, highestPitchM?,
corrections?, images?: [{file, caption?, url}], links?}` where
`url = /data/visits/<slug>/<file>`.

## Milestones

### M1 — stage + validation + CI (no UI) ✅

Done as planned, with recorded additions:

- The in-Scotland check needs a boundary, and CI has no raw data. So
  `boundary.py` now caches the compiled polygon in the committed
  `data/boundary.scotland.geojson` (small, deterministic; refresh by deleting
  it and re-running from a checkout with `data/raw/`). `known.py` and
  `visits.py` both read the cache.
- `mise run test` gained `pipeline:visits-selftest` alongside `pipeline:selftest`.
- Report objects also carry `name` when the YAML supplies one (additive vs the
  schema above — useful for the M2 detail panel; M2: display it).

Selftest: 33 fixture checks (validation + merge, incl. idempotency and the
stale-data rebuild). E2E verified: attach to a logged reach, new-entry path,
skipped snaps leave no images, removing a visit restores `known.json`
byte-for-byte.

1. `pipeline/canyon/visits.py`:
   - discover `data/visits/*/visit.yaml` (skip leading-underscore dirs; add
     `data/visits/_sample/` as the template)
   - strict validate: required fields, types, unknown fields rejected,
     `stars` int 0–4, `date` format, location inside `boundary.scotland`,
     images (extension allow-list jpg/jpeg/png/webp, files exist, ~400 KB
     each, max 6 per visit)
   - snap via the shared helper from `known.py` (refactor first)
   - merge into `known.json`: same chain + overlapping (i,j) → append to
     that entry's `visits`; else new entry `source: "visit"`, `watercourse`
     from `payload.name_at(c, i)`, same measured fields `known.py` emits
   - keep `index_id` = `payload.meta["index_id"]`; copy images into
     `web/public/data/visits/<slug>/`
   - `--selftest`: inline fixture yamls (good / missing field / bad type /
     bad stars / unknown field / oversized image) + correction math, no data
     files needed; wire into `mise run test`
2. `mise.toml` `pipeline:visits` task; update the two pipeline-order strings.
3. `pyyaml` in `pipeline/pyproject.toml` (`uv lock`).
4. `.github/workflows/visits.yml`: on PRs touching `data/visits/` (path
   filter) — install uv + pipeline deps, run the stage, diff regenerated
   `known.json` + image copies against committed ones, fail with
   "run `mise run pipeline:visits` and include the output". Works without the
   raw OS data because the compiled payload is committed.
5. `docs/contributing-visits.md` + README rows (data sources table, using
   the map).

**M1 done when:** a fake visit directory passes end-to-end (validated,
snapped, in `known.json`, images copied), every fixture failure mode is
caught, and CI red/greens on a test PR.

### M2 — web display
1. `types.ts` (`VisitReport` + the two optional `KnownCanyon` fields).
2. `canyonlog.ts` vocabulary (see above) — check every call site of `isDud` /
   `isGraded` still means what it says.
3. `main.ts` detail panel: per-report row (author · date, star tag — `0`
   renders "not worth it" — grade, pitches, highest pitch), escaped
   description, "reported vs measured" line when `corrections` present
   (recompute displayed gradient from corrected drop/length — factor that
   into a pure helper `reportedStats()` for the test), `safeUrl` links, image
   thumbnails → new tab.
4. `web/test/visits.test.ts`.
5. Type-check + full test run + manual pass with the sample visit.

### M3 — fit wiring (parallel with M2)
1. `analyse.py --include-visits` (default off): entry with `visits` →
   positive if any report `stars >= 1`, held-out negative if reports are all
   `stars === 0`; print visit count.
2. `rank.py --include-visits` same scheme at group level.
3. Selftest fixtures proving the labels route correctly and default-off
   behaviour is byte-identical to today's output.

### M4 — flip the gate (only when ~5 real visits exist)
`--include-visits` on → `analyse -> export-groups (web:export-groups) ->
rank`, commit new `score.json` / `group-score.json`, refresh README tables
(`mise run web:thresholds`).

## Verification

```bash
mise run install            # after pyproject changes
mise run test               # web tests + pipeline selftests
mise run pipeline:visits    # regenerate known.json + image copies
mise run web:typecheck
cd pipeline && uv run python -m canyon.visits --selftest
```

Manual: `mise run dev`, open the site, select the sample visit's canyon —
detail panel shows the report, images load from `/data/visits/...`.

## Traps

- **`index_id` staleness is silent on the web side**: `main.ts` `fresh()`
  drops a stale `known.json` wholesale. If `visits.py` emits a stale or
  missing `index_id`, the app "works" with zero visits. The pipeline side
  fails loudly via `require_index`; the web side does not.
- **Do not copy the snapping math** — refactor `known.py` so both stages
  share it; two copies will drift.
- **`category` is the fit's label**: `analyse.py` dispatches on it. Visit
  entries that also carry a `category` must not be double-counted; when
  `--include-visits` is off, entries with `source: "visit"` and a
  non-GRADED/REJECTED category fall into the existing "skipped" bucket —
  verify that's what happens (it should, lines 74–75).
- **Descriptions are untrusted text**: always `esc()`, never template into
  HTML raw. Links through `safeUrl()`.
- **Repo size**: the image caps are a feature, not friction — GitHub-hosted
  static site, and every byte ships to every visitor.
- **CI must not need the raw data** (`data/raw/`, ~215 MB) — it runs the
  stage against the committed compiled payload only.

## Open questions (parked, decide at the milestone that needs them)

1. Reach-window corrections (top/bottom points) — touches `covered()` and
   the fit; values-only until asked for.
2. Ordinal/weighted star treatment in the fit (2★ ≠ 4★) — data already
   retained; needs volume first.
3. Exact M4 gate threshold (~5) — sanity-check with real data in hand.
