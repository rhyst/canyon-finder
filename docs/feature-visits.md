# Feature plan — community visit records

Record visits to prospective canyons, contributed as static pull requests, and
surface them in the app: on the map, in the list, in the detail panel — and
eventually in the promise score.

## Problem

The app's only ground truth is the 148 canyons logged on Canyon Log
(`pipeline/canyon/known.py` → `web/public/data/known.json`). People drive out to
a "good" candidate and find a dud, or find something the tool missed — and there
is no way to feed that back. This feature adds a second, repo-native source of
field reports, with zero infrastructure: a PR is the submission form, GitHub
Pages is the host, and the existing pipeline does the matching.

## Design overview

```
contributor                maintainer                    pipeline / CI
-----------                -----------                   -------------
forks repo
adds data/visits/<slug>/
  visit.yaml + images   ←   reviews (human)      canyon.visits stage:
opens PR                       └─ runs mise run         1. validates schema
                                    pipeline:visits     2. snaps onto chains
                            CI: visits-check job         (reuses known.py logic)
                            validates + asserts         3. copies images
                            artifacts regenerated       4. merges into known.json
                                                        (index-checked)
app reads known.json as it does today; entries carry an optional `visits`
array whose reports have 0–4 stars (Canyon Log vocabulary: 0 = dud). Web shows
reports; analyse/rank take an `--include-visits` gate (off until ~5 visits)
and use the star labels to fit the score.
```

Key decision: **visits merge into `known.json` rather than a separate
`visits.json`.** The app (map layer, `covered()`, group rows, detail panel) and
the score fitters (`analyse.py`, `rank.py`) all already consume `known.json`
entries by `(chain, i, j)`; a second parallel file would mean duplicating all
of that. A visit either enriches an existing snapped canyon or becomes a new
entry with `source: "visit"`.

## 1. Contribution format

One directory per visit, under `data/visits/`:

```
data/visits/
  2026-08-15-allt-arrifish/
    visit.yaml
    top.jpg
    pitch2.jpg
```

Slug = `YYYY-MM-DD-<kebab-case-watercourse-or-canyon>`. One visit per
directory keeps PRs and git merges trivial; a second person reporting the same
canyon adds a second directory and the merge step attaches both to the same
snapped entry.

### visit.yaml

```yaml
# required
author: Rhys
date: 2026-08-15
location: [-5.4123, 56.8765]   # [lon, lat] — nearest point on the canyon
stars: 3                       # 0–4. 0 = visited, not worth the walk; 1–4 = worth it

# optional
name: Allt Arrifish            # defaults to the watercourse name
description: |
  Two solid abseils, big slab at the bottom. Steeper than it looks
  on the map.
grade: WS2 A2                  # free text, like Canyon Log's grades
pitches: 3
highest_pitch_m: 25
corrections:                   # field-measured overrides for DEM values
  drop_m: 40
  length_m: 320
images:
  - file: top.jpg
    caption: Approach to the top
  - file: pitch2.jpg
links:
  - url: https://example.org/notes   # http/https only
```

Rules:
- YAML, not JSON: multiline descriptions and `# comments` for PR discussion
  make it the friendlier contributor format. Adds `pyyaml` to the pipeline
  (one line in `pyproject.toml`).
- `location` is a point, like Canyon Log's markers. The pipeline snaps it to
  the nearest watercourse sample and picks the reach window with the exact
  same logic as `known.py` (`best_reach`, 200–1200 m window, 500 m snap
  radius). A contributor never touches chain/i/j indices.
- `stars` is an integer 0–4, mirroring Canyon Log's star vocabulary ("★★★★",
  "0 Stars") so the two sources read the same: **0 means dud** (the fit's true
  negative), **1–4 means worth it** (a positive). The fit consumes it as
  binary (0 vs 1+) for now; the raw value is kept so an ordinal treatment is
  a later change, not a migration.
- `corrections` override **displayed** measured values only (values, not the
  reach window — see Open questions). The search engine
  never uses them — it operates on `profiles.bin`, not on stored values. If
  both `drop_m` and `length_m` are given, the displayed gradient is
  recomputed from the corrections.

## 2. Pipeline stage: `canyon.visits`

New module `pipeline/canyon/visits.py`, run after `canyon.known` and before
`analyse`. Order line becomes:
`build -> refine -> watershed -> known -> visits -> analyse -> export-groups -> rank`.

Responsibilities:

1. **Validate** every `data/visits/*/visit.yaml`:
   - required fields present, types correct, no unknown fields
   - `location` inside Scotland (same `boundary.scotland` check as `known.py`)
   - `date` well-formed; `pitches`/`highest_pitch_m` positive integers;
     `stars` integer 0–4
   - images: allowed extensions (jpg/jpeg/png/webp), referenced files exist,
     per-image size cap (~400 KB), max 6 per visit — keeps the repo light
   - errors name the file and the field; the stage exits non-zero so a bad
     PR's artifacts can't be generated
2. **Snap** each visit onto a chain, reusing `known.py`'s geometry code —
   refactor the lon/lat → (chain, i, j) computation out of `known.py`'s
   `main()` into an importable helper (e.g. `snap_location(...)`) so the two
   stages share one implementation.
3. **Merge** into `web/public/data/known.json`:
   - visit within one reach window of an existing entry (same chain,
     overlapping i/j) → attach to that entry's `visits` array; the entry keeps
     its Canyon Log fields
   - otherwise → new entry: `source: "visit"`, `name` from the yaml or
     `payload.name_at(c, i)`, same measured fields as `known.py` emits
     (`gradient`, `drop`, `length`, `coords`, …), plus `visits: [<report>]`
   - each report object carries `author`, `date`, `stars`, `description`,
     `grade`, `pitches`, `highestPitchM`, `corrections`, `images`
     (`[{file, caption, url}]` with url = `/data/visits/<slug>/<file>`), `links`
   - record `index_id` exactly like `known.json` does today; `analyse.py` and
     `rank.py` already call `payload.require_index`, so a stale visits merge
     fails loudly instead of pointing at the wrong burn
4. **Copy** images into `web/public/data/visits/<slug>/` (the Pages root),
   byte-for-byte, after the size checks.

Also add `mise run pipeline:visits` (mirrors `pipeline:known`) and update the
order line in `payload.require_index`'s error message.

## 3. CI: `visits-check` workflow

New `.github/workflows/visits.yml`, triggered on PRs that touch
`data/visits/` (path filter). The compiled payload is committed to the repo, so
CI can run the stage without fetching the ~215 MB of raw OS data:

1. install uv + pipeline deps
2. run `python -m canyon.visits` (regenerates known.json + image copies in a
   scratch copy of the working tree)
3. diff the regenerated artifacts against the PR's committed ones — fail with
   "run `mise run pipeline:visits` and include the output" on mismatch

This enforces schema validation, snap success (a mislocated point >500 m from
any watercourse fails here with a readable message), and artifact freshness —
all before a human reviews. The deploy workflow stays as-is: it still never
runs the pipeline.

## 4. Web app

### Data (`web/src/types.ts`)

```ts
export interface VisitReport {
  author: string;
  date: string;            // YYYY-MM-DD
  stars: number;           // 0–4, Canyon Log vocabulary: 0 = dud, 1+ = worth it
  description?: string;
  grade?: string;
  pitches?: number;
  highestPitchM?: number;
  corrections?: { dropM?: number; lengthM?: number; gradient?: number };
  images?: { file: string; caption?: string; url: string }[];
  links?: string[];
}

// on KnownCanyon:
  source?: 'canyon-log' | 'visit';   // 'canyon-log' when omitted
  visits?: VisitReport[];
```

`canyonlog.ts` vocabulary grows:
- `isDud(k)` → `category === ZERO_STAR` **or** (visit-sourced entry whose
  reports are all `stars === 0`)
- new `isWorthwhile(k)` → `isGraded(k)` or (visit entry with any report
  `stars >= 1`). The "catches N of M logged" counters, `covered()` and the
  map's graded/dud styling all key off these, so they pick visits up
  without further changes.

### UI (`web/src/main.ts`)

- **Detail panel** (`selectKnown`): below the measured stats, render each
  report: author · date, a star tag (0 = `not worth it`, 1–4 = stars),
  grade, pitches + highest pitch, description (escaped via `esc()` — it is
  HTML-shaped user text), links through the existing `safeUrl()`. When `corrections` are
  present, show a "reported: 40 m over 320 m (12.5%)" line next to the
  "measured:" line, with a tooltip that corrections are field-measured and
  don't affect search.
- **Images**: thumbnail row in the detail panel; click opens
  `/data/visits/<slug>/<file>` in a new tab. No lightbox in v1 — the files are
  plain static paths and a new tab is three lines.
- **Map**: visit entries ride the existing `known` layer (dashed line green
  when worthwhile, grey when a dud — the current `isDud`-driven styling does
  the work). Optional cosmetic: a small dot marker for visit-sourced entries
  so field reports are visually distinguishable from Canyon Log entries.
- **List**: group rows already show how many logged canyons sit on each
  watercourse; with `isWorthwhile`/`isDud` extended, visit entries count the
  same way.

### Tests

- `web/test/visits.test.ts` (same pattern as `search.test.ts`): loads the
  real `known.json`; asserts visit entries parse, `isDud`/`isWorthwhile`
  classify the fixture reports correctly, and a pure helper
  `reportedStats(measured, corrections)` returns the right override
  arithmetic.
- `canyon.visits --selftest` (mirrors `watershed --selftest`): schema
  validation against inline fixture yamls (good, missing field, bad type,
  bad image size, unknown field) and correction math — no data files needed,
  runs under `mise run test`.

## 5. Score integration (built with the display, gated on data volume)

`analyse.py` fits graded descents vs background; the 17 "0 Stars" are held out
as true negatives. `rank.py` does the same at watercourse level. Visits slot
into exactly this scheme, and the wiring is **built in the same milestones as
the display** — the gate is data volume, not effort:

- positives: graded **or** a visit report with `stars >= 1`
- held-out negatives: "0 Stars" **or** a visit report with `stars === 0`
- AUC-vs-zero-star is already reported, so the effect of each new visit is
  visible in the stage output

Gate: a `--include-visits` flag (off by default) on `analyse` and `rank`.
Until there are ~5+ visits on top of the 148 Canyon Log entries the flag stays
off — below that volume one misremembered "not worth it" wobbles the fit more
than it informs it. When the count is reached: flip the flag, re-run
`analyse -> export-groups -> rank`, commit the new `score.json` /
`group-score.json`, and update the README tables (`tools/thresholds.ts`). The
stage prints the current visit count so the gate is a visible number, not a
hunch.

The fit uses profile-derived features either way — corrections and report
text never enter it; only the star labels do.

## 6. Docs

- `docs/contributing-visits.md`: how to add a visit (take the sample file,
  drop it in, `mise run pipeline:visits`, open the PR with the regenerated
  `known.json` + images), the schema, the image budget, and what the CI check
  will tell you when something is wrong.
- Sample: `data/visits/_sample/` (excluded from the stage via the leading
  underscore; shown in the contributing doc).
- README: one row in "Where the data comes from" — *Community visits: pull
  requests to this repo (see docs/contributing-visits.md)* — and a line under
  "Using the map" about field reports.

## Milestones

| # | Scope | Depends on |
| --- | --- | --- |
| M1 | Format + `canyon.visits` stage (validate/snap/merge/copy) + `pipeline:visits` task + selftest + contributing doc + CI check | — |
| M2 | Web display: types, vocabulary, detail panel (stars, text, pitches, corrections, images), counters, tests | M1 |
| M3 | Score fit wiring: `--include-visits` on analyse/rank + selftest fixtures + doc | M1 |
| M4 | Flip the gate: re-fit, commit new score files, README tables | ~5 visits in |

M1 and M2 are small and independent of any real data; M1's CI check can merge
even before a single visit exists.

## Risks and edge cases

- **Mislocated points** (burn not in Open Rivers, loch outlet, phone GPS
  drift): snap radius already fails at 500 m with a message; make the message
  actionable ("check the location, or the canyon may not sit on a mapped
  channel — drop a comment on the PR").
- **Repo growth**: enforced by the per-image/per-visit caps in the validator.
  Even 100 visits × 6 × 400 KB ≈ 240 MB worst case; realistically far less.
- **Corrections vs DEM disagreeing wildly**: we display both and never blend
  them, so a wrong correction can't poison search or the fit — the fit uses
  profile-derived features, not stored values.
- **Two sources, one entry**: a visit near a Canyon Log entry attaches rather
  than duplicates, so the map never draws two lines for the same gorge; the
  detail panel shows the Canyon Log grade *and* the field reports.
- **Privacy**: point precision matches what Canyon Log already publishes
  (their markers carry ~10 m precision); no additional concern.
- **Malicious content**: descriptions/links are PR-reviewed human text rendered
  through `esc()` and `safeUrl()`; the only new attack surface is images,
  which are stored under an extension allow-list and never executed.

## Open questions

1. **Reach-window correction** (deferred): should corrections also allow
   moving the reach (top/bottom points) instead of just drop/length? It's the
   one correction that would touch `covered()` and the fit; v1 is values only.
2. **Star semantics for the fit**: binary 0-vs-1+ is the v1 treatment. An
   ordinal/weighted treatment (2-star ≠ 4-star) is possible later with the
   data already in hand — not worth the complexity until there's volume.
3. **Gate threshold**: ~5 visits before flipping `--include-visits` on —
   sanity-check when M4 comes around.
