# Canyon Finder — architecture

Finds watercourse sections steep enough to be worth looking at for canyoning: X metres of
drop over Y metres of channel. Great Britain is precompiled into a ~46 MB payload (20 MB gzipped) that the browser
filters itself: sections are measured once at load (~0.3 s) and every slider move is a
~3 ms filter, with no server.

The user-facing overview lives in the top-level README; this document is the technical
record for people changing the code or the data.

```
pipeline/   compile step: OS data -> profiles.bin + profiles.json
web/        interactive map (Vite + MapLibre + a Web Worker doing the search)
```

## Data sources

| What | Source | Licence | Why |
| --- | --- | --- | --- |
| Watercourse network | [OS Open Rivers](https://docs.os.uk/os-downloads/products/water-portfolio/os-open-rivers) (GeoPackage, 52 MB) | OGL v3 | Topological link/node network with flow direction — gives connected channels and catchment accumulation for free. 63,210 km in Scotland. |
| National elevation | [OS Terrain 50](https://docs.os.uk/os-downloads/products/land-and-terrain-portfolio/os-terrain-50) (ASCII grid, 162 MB) | OGL v3 | The only open, genuinely bare-earth DTM covering all of Scotland. 50 m post spacing. |
| High-res elevation, Scotland | [Scottish public sector LiDAR](https://remotesensingdata.gov.scot/) via `s3://srsp-open-data` | OGL v3 (some phase-2 LAZ is non-commercial) | 0.5–2 m DTMs as cloud-optimised GeoTIFFs, read over HTTP range requests. Patchy coverage — see below. |
| High-res elevation, England | [Environment Agency LIDAR composite DTM](https://environment.data.gov.uk/survey), 2 m | OGL v3 | National composite as zipped 5 km tiles. Downloaded one at a time: the service rejects parallel requests and its WCS allows about one request every ten seconds. |
| High-res elevation, Wales | [Welsh Government LiDAR DTM](https://datamap.gov.wales/) | OGL v3 | One national cloud-optimised GeoTIFF, read at its 2 m overview over HTTP range requests. |
| Dam structures | [OpenStreetMap](https://www.openstreetmap.org/) | ODbL | Line features tagged `waterway=dam` or `man_made=dam`; crests at least 100 m long flag likely spillways and embankment slopes. |
| Region outline | Natural Earth 10m map subunits | Public domain | Clips the payload and Canyon Log to Great Britain. |
| Known descents | [Canyon Log](https://canyonlog.org/map/) via `wp-json/mapster-wp-maps/map?id=17437` | No stated licence — credit it, ask before redistributing | 148 community-logged Scottish canyons, snapped onto our profiles. Calibrates the thresholds and measures recall. |

The data files are all OGL v3 unless noted in the table above; `./fetch.sh` downloads
the raw inputs into `data/raw/`.

### LiDAR cannot be the primary elevation source

Coverage was flown for flood risk, power corridors and heritage sites, so it lands in the
Central Belt and Borders rather than the Highlands. Coverage comes from the portal's
`scotland:lidar-aggregate` WMS mask, not the rectangular DTM file footprints: old Phase
1/2 files are often mostly nodata, so counting their whole bounds badly overstates it.
Measured against this project's own shortlist (`python -m canyon.coverage`):

```
watercourses with a 400 m window at or above 12%: 5,646
  LiDAR none               4,347   77.0%
  LiDAR full, 0.5 m          551    9.8%
  LiDAR partial              445    7.9%
  LiDAR full, 1 m            278    4.9%
  LiDAR full, other           25    0.4%
```

Skye (NG) has no coverage at all; Lochaber (NN) has a handful of tiles. The Ochils are a
sharp illustration — LiDAR covers the lowland burns around the Devon but not Alva Glen or
Dollar Glen a few kilometres uphill.

So: Terrain 50 is the national baseline, and LiDAR is an opt-in per-region refinement.
Rejected alternatives: Copernicus DEM EEA-10 (10 m, restricted to public authorities),
Copernicus GLO-30 (surface model, includes tree canopy), OS Terrain 5 (not open).

## Pipeline

```bash
cd pipeline
./fetch.sh                                         # raw open data, ~215 MB
uv run python -m canyon.build                      # whole region, ~2 min
uv run python -m canyon.build --bbox 270000 755000 295000 780000   # one region
uv run python -m canyon.validate                   # check against known venues
uv run python -m canyon.coverage                   # LiDAR coverage of the shortlist
uv run python -m canyon.refine --bbox 283000 692000 302000 704000  # Scottish LiDAR re-profile
uv run python -m canyon.refine --source england-wales              # hours; resumes where it stopped
uv run python -m canyon.lidarmap                   # coverage outline -> lidar.json
uv run python -m canyon.dams                       # OSM dams -> profile flags
uv run python -m canyon.sections                   # steep sections -> profiles.json (after refine)
uv run python -m canyon.known                      # logged canyons -> known.json
uv run python -m canyon.watershed                  # drainage area per sample
uv run python -m canyon.watershed --selftest       # routing on known grids
uv run python -m canyon.rank                       # fit the section ranking -> score.json
```

What `build` does:

1. Loads every Terrain 50 tile for Scotland into memory (1,291 tiles, 50 m grid).
2. Reads OS Open Rivers and accumulates upstream channel length per link (Kahn's
   algorithm over the link graph) — the water-volume proxy.
3. Traces **main-stem chains**: at each confluence the downstream link is claimed by the
   largest-catchment tributary, so every link belongs to exactly one chain and each chain
   reads as one continuous river from source to mouth.
4. Resamples each chain to fixed 25 m spacing, samples elevation bilinearly, and forces
   the profile non-increasing downstream (a 50 m DEM sampled along a stream produces
   uphill bumps that are DEM error, not terrain).
5. Samples **valley confinement** per point: the rise of the *lower* of the two banks
   100 m out, perpendicular to flow. Both sides have to climb for a reach to be enclosed.
6. Drops chains with no window anywhere near steep (< 4% at every scale), then packs
   elevation (int16 dm), upstream length (uint16), delta-encoded geometry (int16 at 1e-7°,
   exact on reconstruction), drainage area (uint16, delta of √km² — see `payload.py`) and
   confinement (uint8 m, written last so it cannot misalign the int16 arrays) into
   `profiles.bin`. `canyon.watershed` fills the drainage array in afterwards, the way
   `refine` rewrites elevation.

`canyon.dams` fetches Scotland's mapped dam lines from OpenStreetMap, keeps crests at
least 100 m long, and marks profile samples within 150 m. This excludes tiny weirs and
intakes whose downstream burns remain useful. The browser hides sections
overlapping those runs by default, except non-dud Canyon Log descents, but the switch
remains reversible because OSM can be incomplete or occasionally wrong. Reservoir outlets alone
are deliberately not used: natural loch
outlets include real logged canyons.

`refine` replaces those profiles with LiDAR ones where tiles exist. It samples the
**minimum elevation within 12 m** of each point rather than the point itself: OS Open
Rivers centrelines are good to a few tens of metres, and a point sample of a 1 m DTM can
land on the gorge wall instead of the water.

Fixed 25 m spacing means the payload needs no distance array: a length is a sample count.

## Web app

```bash
cd web
npm install
npm run dev
node --experimental-strip-types test/search.test.ts   # search engine tests
node --experimental-strip-types test/state.test.ts    # session persistence tests
```

Publishing is a static build: the compiled payload is committed, so nothing
fetches or processes data at deploy time — `npm run build` packages it. GitHub
Pages serves it via `.github/workflows/deploy.yml`. The bundle uses a
relative base, so it works at any subpath or custom domain; Canyon Log has
agreed to the derived logged-canyon data being published with credit.

### Sections

The unit everything works in is the **steep section**: a fixed stretch of one river,
decided by the river and not by a query. `canyon.sections` finds them:

1. Fit each chain's long profile with straight pieces of uniform slope — penalised least
   squares, solved exactly by dynamic programming, each breakpoint having to save 60 m² of
   squared error (`PENALTY`). Pieces are at least 75 m.
2. A piece at 5% or more is steep. So is the fall *between* two pieces: a waterfall
   between two pools leaves neither pool steep.
3. Steep pieces within 200 m of each other merge — pool-drop is one canyon — and anything
   falling under 10 m is dropped.

That yields 26,515 sections on 22,926 of the 37,309 chains, median 500 m long. The settings
were chosen by sweeping against Canyon Log: 129 of the 138 descents rated one star or more
sit on a section. The misses are gentle slot gorges (Meig, Calvine) that are canyons for
their walls, not their gradient.

Sections are stored as inclusive sample ranges on each chain in `profiles.json`. Elevation
decides them, so the stage runs after `refine`.

The worker measures every section once at load (`search.ts`): length, drop, gradient,
steepest 100 m, drainage at head and foot, mean and maximum confinement. A query only
filters that list, in about 3 ms. Filters choose among sections and never reshape them, so
one stretch of water has one set of numbers whatever the sliders say. The drainage ceiling
is tested at the foot, where the figure is largest.

The list groups sections by named watercourse for display. A watercourse has no score of
its own: its row shows its best section.

`node --experimental-strip-types tools/why.ts "Some Burn"` lists a watercourse's sections
with their ranks and tags; `tools/thresholds.ts` reports what each preset and filter keeps
of the logged descents.

| preset | filter | logged caught | sections |
| --- | --- | --- | --- |
| Shortlist | top 10% | 142/179 | 2,577 |
| Everything | none | 160/179 | 26,392 |
| Steep small burns | ≥15%, ≤5 km² | 42/179 | 4,677 |
| Big water | ≥15 km² | 26/179 | 477 |

**Hide single drops** drops sections with 70% or more of their fall inside one 100 m
stretch — a lone waterfall, a cliff or a dam wall — unless a logged descent sits on them.
286 of the top 10% are like this, against 5 of the 125 rated canyons.

**Hide logged** drops watercourses a Canyon Log entry sits on — an entry whose measured
window overlaps one of its sections, with a 250 m proximity fallback for entries that
snapped to a neighbouring burn; watercourses that keep one are tagged `logged` with the
canyon's name. Selecting a section draws its elevation profile and links out to OS Maps
and satellite imagery; selection never moves the map. Sections and logged canyons draw as
dots below zoom 11 and as lines above it.

**The session is remembered.** The last map position, filter panel and selection are
saved to localStorage (key `canyon-finder/v2`) and restored on load: the map opens
where you left it, the sliders come back as they were, and the selected section, watercourse
or logged canyon is re-selected once the results render. The preset dropdown shows the
matching preset when the saved sliders equal one of them, otherwise Custom. Saved values
are validated before use (`src/state.ts`), so a corrupt or foreign entry is dropped
rather than trusted, and a failed write — private mode, full quota — just means the app
forgets. `node --experimental-strip-types test/state.test.ts` covers it.

## Ranking

`web/tools/export-sections.ts` dumps every section as the app measures it, and
`python -m canyon.rank` fits a logistic model on them: 125 sections holding a Canyon Log
descent rated one star or more, against the 26,287 with nothing logged. Sections holding
only a 0-star or unrated entry are left out. Features are chosen by forward selection on
5-fold out-of-fold AUC, stopping when the next one adds under 0.002:

| step | feature | out-of-fold AUC |
| --- | --- | --- |
| 1 | maximum confinement (≤60 m) | 0.860 |
| 2 | number of drops (log) | 0.906 |
| 3 | drainage area (log, ≤10 km²) | 0.946 |
| 4 | steepest 100 m | 0.951 |

A drop is a run of samples at 20% or more falling at least 8 m.

**The score is shown as a rank, with what a rank is worth.** A calibrated probability is
useless to read at a 0.5% base rate, so the app shows where a section sits among all of
them — "top 3%" — and the capture curve says what that means. Out of fold:

| top share of sections | rated canyons it holds |
| --- | --- |
| 1% | 37% |
| 2% | 49% |
| 5% | 72% |
| 10% | 86% |
| 25% | 98% |

**It transfers.** Fitted on Scotland alone it scores AUC 0.952 on England and Wales;
fitted on England and Wales, 0.951 on Scotland.

**It finds canyons; it does not grade them.** Median rank by Canyon Log rating runs 0★ top
5%, 1★ and 2★ top 3%, 3★ and 4★ top 1% — ordered, but the 0-star reports sit in the
top 5% with everything else people bothered to walk to. No measurement here separates a
good descent from a dull one.

**Tags say why.** `score.json` carries the rated canyons' medians, and a section shows a
tag where it reaches one: steep (15% overall), big drop (188 m), N drops (3 or more), confined (16 m). A section
with most of its fall in one 100 m stretch is tagged single drop instead. Water is tagged against the range holding the middle 80% of rated
canyons, 0.4–33 km², as good, little or big. A section also says whether it was measured
on LiDAR or the 50 m model.

The app draws logged canyons as dashed lines — **green** for a descent someone rated,
**grey** for a "0 Stars" report — and the status line shows `catches N/179 logged
descents` for the current filters. A canyon is caught when a returned section overlaps
its window. The category strings live in `src/canyonlog.ts` and are asserted in the tests,
since they come from someone else's CMS. A star count of 0 means Canyon Log's "0 Stars"
category only; a grade carrying no stars is unrated.

## Caveats

- A 50 m DTM smooths narrow gorges and cannot see individual waterfalls; gradient is a
  lead to check on imagery, not a survey. Each section is tagged with the elevation it was measured on.
- OS Open Rivers omits the smallest burns, so some steep channels are simply absent.
- Gradient is blind to gorge *narrowness*: Monessie Gorge is a well-known slot that reads
  as 4% and never appears. Confinement would need a cross-valley relief metric, which a
  50 m DEM cannot supply.
- The ranking is fitted on 125 sections holding a rated canyon. It reproduces what has been logged, which is
  biased towards accessible and well-known water — it is a prioritiser, not a verdict.
- Sections start at 5%, so one can run for kilometres: Turret Burn's headwall section is
  2.9 km. Its figures are averages over all of it.
- Dam walls read as short, very steep sections on LiDAR. The dam flag hides most.
- Confinement takes the *lower* of the two banks, so a burn incised into a hillside — one
  side climbing 50 m, the other falling away — scores near zero however deep its slot is.
  Glentarken Burn is the example: 18.5% over 575 m but 3 m of confinement, and no LiDAR
  coverage to check. At 50 m spacing this metric measures landform, not gorge.
- Nothing here knows about access, land ownership, in-stream hazards or water levels.
