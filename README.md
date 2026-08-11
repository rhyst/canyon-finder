# Canyon Finder — Scotland

Finds watercourse reaches steep enough to be worth looking at for canyoning: X metres of
drop over Y metres of channel. All of Scotland is precompiled into a ~16 MB payload
(8 MB gzipped) that the browser searches itself, so gradient and length sliders re-query
2 million elevation samples in ~200 ms with no server.

```
pipeline/   compile step: OS data -> profiles.bin + profiles.json
web/        interactive map (Vite + MapLibre + a Web Worker doing the search)
```

## Data sources

| What | Source | Licence | Why |
| --- | --- | --- | --- |
| Watercourse network | [OS Open Rivers](https://docs.os.uk/os-downloads/products/water-portfolio/os-open-rivers) (GeoPackage, 52 MB) | OGL v3 | Topological link/node network with flow direction — gives connected channels and catchment accumulation for free. 63,210 km in Scotland. |
| National elevation | [OS Terrain 50](https://docs.os.uk/os-downloads/products/land-and-terrain-portfolio/os-terrain-50) (ASCII grid, 162 MB) | OGL v3 | The only open, genuinely bare-earth DTM covering all of Scotland. 50 m post spacing. |
| High-res elevation | [Scottish public sector LiDAR](https://remotesensingdata.gov.scot/) via `s3://srsp-open-data` | OGL v3 (some phase-2 LAZ is non-commercial) | 0.5–2 m DTMs as cloud-optimised GeoTIFFs, read over HTTP range requests. Patchy coverage — see below. |
| Country outline | Natural Earth 10m map subunits | Public domain | Clips the payload to Scotland. |
| Known descents | [Canyon Log](https://canyonlog.org/map/) via `wp-json/mapster-wp-maps/map?id=17437` | No stated licence — credit it, ask before redistributing | 146 community-logged Scottish canyons, snapped onto our profiles. Calibrates the thresholds and measures recall. |

Both OS products download without an API key:

```
curl -L -o terr50_gagg_gb.zip \
  "https://api.os.uk/downloads/v1/products/Terrain50/downloads?area=GB&format=ASCII+Grid+and+GML+%28Grid%29&redirect"
curl -L -o oprvrs_gpkg_gb.zip \
  "https://api.os.uk/downloads/v1/products/OpenRivers/downloads?area=GB&format=GeoPackage&redirect"
```

### LiDAR cannot be the primary elevation source

Coverage was flown for flood risk, power corridors and heritage sites, so it lands in the
Central Belt and Borders rather than the Highlands. Measured against this project's own
shortlist (`python -m canyon.coverage`):

```
watercourses with a 400 m window at or above 12%: 5,646
  LiDAR none               3,274   58.0%
  LiDAR full, 1 m          1,343   23.8%
  LiDAR full, 0.5 m          792   14.0%
  LiDAR partial              237    4.2%
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
uv run python -m canyon.build                      # all Scotland, ~20 s
uv run python -m canyon.build --bbox 270000 755000 295000 780000   # one region
uv run python -m canyon.validate                   # check against known venues
uv run python -m canyon.coverage                   # LiDAR coverage of the shortlist
uv run python -m canyon.refine --bbox 283000 692000 302000 704000  # LiDAR re-profile
uv run python -m canyon.known                      # logged canyons -> known.json
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
   exact on reconstruction) and confinement (uint8 m, written last so it cannot misalign
   the int16 arrays) into `profiles.bin`.

`refine` replaces those profiles with LiDAR ones where tiles exist. It samples the
**minimum elevation within 12 m** of each point rather than the point itself: OS Open
Rivers centrelines are good to a few tens of metres, and a point sample of a 1 m DTM can
land on the gorge wall instead of the water.

Fixed 25 m spacing means the payload needs no distance array, and window lengths become
integer sample counts — which is what makes the browser-side scan cheap.

## Web app

```bash
cd web
npm install
npm run dev
node --experimental-strip-types test/search.test.ts   # search engine tests
```

The worker holds the whole dataset and, per query, emits reaches **steepest-first**: find
the highest-gradient window in the requested length band, grow it outwards while it keeps
80% of that gradient, then recurse either side. Chains are skipped via precomputed max
gradients at 100/200/400/800/1600/3200 m, and reaches within a chain never overlap.

Scanning left-to-right instead — taking the longest run that still averages above the
threshold — looks equivalent and is not: a long shallow reach swallows the steep core
inside it, and because reaches cannot overlap, the core is never reported. Glentarken Burn
came back as 17.6% over 600 m when its steepest 200 m is 22.7%.

### How a reach's length is decided

Nothing sets it directly — it is emergent, and the length sliders only bound it:

1. Every sample sits on a fixed 25 m grid, so all lengths are multiples of 25 m.
2. The search finds the **steepest window** whose length falls inside your min/max band and
   which passes the catchment, altitude and confinement filters.
3. That window then **grows outwards**, one sample at a time, while the whole reach still
   averages at least 80% of its peak gradient (`SHOULDER` in `search.ts`) and never drops
   below your minimum. Growth stops at your maximum length.
4. The scan then recurses into the channel above and below the emitted reach.

So a reach is "the steepest bit, extended as far as the steepness holds up". Min length is
the shortest window that can be a peak — set it to 100 m and a burn returns short steep
steps; set it to 400 m and you get sustained sections. Step 4 is why one watercourse yields
several reaches: each is a distinct steep zone separated by slacker channel.

### Grouped results

Long descents produce many reaches — Lawers Burn drops 685 m over 7.8 km and yields 11
under the calibrated preset. The list groups them by watercourse, one row each, summarising
the whole descent:

```
Lawers Burn                                        18%
11 reaches · 381 m of drop in 2.9 km of steep channel · 436 m over a 3.8 km span
```

Expanding shows each reach; selecting the header highlights all of them and profiles the
full span. Grouping only bites where it matters — of 618 watercourses in a calibrated
shortlist, 380 hold a single reach and just 37 hold four or more.

`node --experimental-strip-types tools/why.ts "Some Burn"` explains where any watercourse
sits: its reaches, the true steepest window on the chain, and its rank under each preset.

**Presets** set every slider at once, from the analysis rather than from taste:

| preset | gradient | length | catchment | confinement | sort | graded canyons in band |
| --- | --- | --- | --- | --- | --- | --- |
| Calibrated shortlist | ≥12% | 200–600 m | ≥3 km | — | score | 62/91 |
| Wide net — prospecting | ≥8% | 200–2000 m | ≥1 km | — | score | 81/91 |
| Big water | ≥10% | 200–1200 m | ≥8 km | — | score | 75/91 |
| Tight gorge | ≥12% | 200–800 m | ≥2 km | ≥20 m | confinement | 64/91 |
| Waterfall hunting | ≥20% | 100–300 m | ≥2 km | — | steepest 100 m | 30/91 |
| Steep small burns | ≥15% | 150–800 m | 0.5–6 km | — | total drop | 44/91 |
| Long descents | ≥8% | 1000–5000 m | ≥3 km | — | length | 2/91 |

Long descents catches almost no logged canyon because logged canyons are short (median
250 m) — it is for finding sustained steep sections, not rediscovering venues. Steep small
burns exists because every other preset carries a catchment floor of 2 km or more, which
excludes genuinely steep small water: Allt Coire Sgamadail runs 28% over 175 m with a
34% steepest-100 m, on 1.2 km of upstream channel, so only this preset and the wide net
reach it. It sorts by drop rather than promise, since promise underrates headwaters.

**A catchment ceiling costs recall, so it is worth knowing the price.** Upstream length has
a maximum as well as a minimum, since a 600 km river is not what most people mean by a
canyon. But big water hosts real descents — Bruar sits on 49 km, Falls of Foyers on 182 km —
so the ceiling trades them away (measured at ≥12% over 200–600 m, no minimum):

| ceiling | graded canyons still reachable |
| --- | --- |
| 3 km | 27 of 91 |
| 6 km | 54 of 91 |
| 10 km | 63 of 91 |
| 20 km | 69 of 91 |
| 30 km | 73 of 91 |
| none | 76 of 91 |

The slider's top position means no ceiling rather than 100 km. Only the small-burns preset
sets one (6 km), since that is the point of it.

The bound is tested at the *foot* of a reach, not its head: upstream length grows downstream,
so the head carries the smallest figure and testing it there would let a reach spill into
bigger water than asked for.

**Nothing is capped.** Results used to be trimmed to the top 1000 reaches before grouping,
which let a *looser* preset display *fewer* rows than a stricter one: wide net found 5,337
watercourses but showed 643, because rivers carrying a dozen reaches each ate the quota,
against the calibrated shortlist's 618 of 893. Rather than move the cap, it was measured and
removed — the cost never justified it:

| query | reaches | watercourses | search | group | transfer | map geometry |
| --- | --- | --- | --- | --- | --- | --- |
| calibrated (12%) | 1,449 | 893 | 25 ms | 4 ms | 0.6 MB | — |
| wide net (8%) | 23,634 | 5,337 | 99 ms | 54 ms | 4.6 MB | 342k vertices, 12 MB |
| loosest the sliders allow (2%) | 205,359 | 22,096 | 1.1 s | 250 ms | 55 MB | 875k vertices, 51 MB |

So realistic queries are trivial and even the absurd end is merely slow. The list renders
120 rows at a time as you scroll, geometry is built only for reaches that get displayed, and
a 400k-reach backstop exists solely to bound memory — it sits just under the arithmetic
ceiling of 24 reaches × 18,652 chains, so no real query reaches it, and if one did the status
line says `search truncated` rather than trimming quietly.

A test asserts a looser query never shows fewer watercourses and that its reaches cover the
stricter query's, compared by channel position rather than name — a longer maxLength can grow
a reach upstream past a name change, relabelling a group without losing any water.

Alongside the presets you can filter on gradient, length, upstream channel length (both
ends — a ceiling keeps major rivers out), valley confinement and altitude, and sort by **promise** (the default, shown on every group row),
total drop, gradient, steepest 100 m, length, catchment or confinement. Promise is the only
score the UI exposes; the reach-level fit from `canyon.analyse` survives as the internal
tie-breaker deciding which reaches survive the result cap, and as the evidence for which
features matter. **Hide logged** drops watercourses within 250 m of
a Canyon Log entry, which is the prospecting view; groups that keep one are tagged
`logged`. Selecting a reach draws its elevation
profile and links out to OS Maps and satellite imagery. Basemap switches between
OpenTopoMap and Esri satellite imagery. Reaches and logged canyons draw as dots below
zoom 11 and as lines above it, so a Scotland-wide view stays readable.

## Validation

**Recall against Canyon Log.** `python -m canyon.known` pulls the 149 logged Scottish
canyons, drops 3 with no watercourse within 500 m, and snaps the rest onto our profiles
(90th percentile snap distance 44 m). The search recovers **139 of 146 (95%)** at 8% over
200–2000 m. All seven misses measure 4–6% — including Monessie Gorge, which is a narrow
constriction rather than a cascade, so a gradient-only criterion cannot see it.

Their measured gradients set the sensible defaults:

| percentile | gradient | length |
| --- | --- | --- |
| p10 | 8.7% | 200 m |
| p25 | 14% | 200 m |
| p50 | 21% | 250 m |
| p75 | 33% | 394 m |
| p95 | 48% | 800 m |

The app draws them as dashed lines — **green** for a descent someone rated, **grey** for a
"0 Stars" report — and the status line shows `catches N/91 logged descents` for the current
filters, so you can see what a threshold is throwing away. It counts graded descents only
(catching a 0-star is not a virtue) and it counts *coverage*: a logged canyon is caught when
the search returns a reach overlapping it. Testing each canyon's stored gradient and length
against the sliders instead looks equivalent and is not — it ignores catchment, confinement
and altitude, so the number sat still while those filters discarded canyons. Grey markers are the useful negative: a nearby
candidate that looks like a dud someone already walked into deserves less of your weekend.
The category strings live in `src/canyonlog.ts` and are asserted in the tests, since they
come from someone else's CMS.

### What separates a canyon from a steep burn

`python -m canyon.analyse` compares 91 graded descents (Basic/Moderate/Advanced) against
17 "0 Stars" entries — places people walked in and found not worth it — and against 26,820
background reaches (steepest non-overlapping 200–600 m window at ≥8% on every chain).
Medians with interquartile range, and AUC as the discriminating power:

| feature | graded | 0-star | background | AUC v 0-star | AUC v background |
| --- | --- | --- | --- | --- | --- |
| gradient | 0.20 | **0.25** | 0.10 | 0.41 | 0.73 |
| catchment (km upstream) | **4.6** | 2.3 | 0.6 | **0.69** | 0.84 |
| confinement at 100 m (m) | **11.2** | 6.2 | 4.0 | 0.64 | 0.69 |
| steepest 100 m | 0.30 | 0.31 | 0.16 | 0.48 | 0.77 |
| steepest 25 m step | 0.46 | 0.48 | 0.23 | 0.56 | 0.84 |
| fraction of reach ≥15% | 0.60 | 0.75 | 0.25 | 0.34 | 0.71 |
| altitude at top (m) | 208 | 191 | 245 | 0.50 | 0.42 |
| length (m) | 250 | 225 | 275 | 0.49 | 0.43 |
| total drop (m) | 58 | 68 | 35 | 0.46 | 0.70 |

**Gradient does not tell a good canyon from a dud.** The 0-star reaches are *steeper* than
the graded ones (25% vs 20%, AUC 0.41). Steepness separates canyons from streams in
general (0.73) but among places people actually visited it carries almost no signal. Treat
it as a sieve, not a ranking.

**Catchment is the best discriminator** — 4.6 km of upstream channel at graded canyons
versus 2.3 km at duds and 0.6 km in the background. Enough water is what makes a steep
reach worth the walk. This comparison also controls for access bias: both groups are
places someone walked into.

**Confinement is second** and is the only new information beyond steepness, but a 50 m DEM
flattens gorge walls, so it works as a ranking signal rather than a hard cut. It should
sharpen considerably on LiDAR-refined reaches.

**Altitude, length, drop and every restatement of steepness are useless** for this
distinction (AUC 0.34–0.58 against 0-star).

What filters cost, and how much sifting they save:

| rule | graded kept | 0-star kept | pool | candidates per graded canyon |
| --- | --- | --- | --- | --- |
| gradient ≥ 10% | 82% | 94% | 13,578 (51%) | 181 |
| gradient ≥ 20% | 52% | 65% | 3,872 (14%) | 82 |
| catchment ≥ 2 km | 77% | 53% | 5,348 (20%) | 76 |
| catchment ≥ 5 km | 47% | **12%** | 1,543 (6%) | 36 |
| confinement ≥ 20 m | 29% | 6% | 2,702 (10%) | 104 |
| gradient ≥ 10% & catchment ≥ 2 km | 60% | 47% | 1,545 (6%) | 28 |
| gradient ≥ 15% & catchment ≥ 3 km | 36% | 24% | 280 (1%) | **8** |

A logistic fit on the three useful features (standardised weights: catchment +1.12,
gradient +0.84, confinement +0.23) scores **AUC 0.94** against background and 0.69 against
0-star, and its top 2% of the pool holds 51% of all graded canyons. The catchment term is
**capped at 50 km** — chosen by AUC against the 0-star set. Uncapped it ranked the River
Clyde (617 km upstream) above every real gorge, because more water is only evidence of a
canyon up to a point. The fit ships as `score.json`, including the feature order, caps and
transform, so the browser cannot drift from what was fitted.

Sorting the calibrated shortlist by that score puts known venues (Falls of Foyers, Falls of
Bruar, End of the World) alongside reaches Canyon Log has never logged — River Tarff at 13%
over 200 m with 48 km upstream and 72 m of confinement tops it. Whether those are real is
the point of the tool.

### Ranking whole watercourses: promise

The reach score answers "is this 300 m steep". Choosing where to drive is a question about
the *watercourse*, so `canyon.rank` fits a second model at that level, on features exported
from the app's own search (`web/tools/export-groups.ts`) so model and UI cannot drift.
Positives are the 84 groups holding a graded descent; background is the other 11,542. The
17 zero-star groups are held out entirely — too few to train on.

Features are chosen by forward selection on **out-of-fold** AUC, which stops early:

| step | added | out-of-fold AUC |
| --- | --- | --- |
| 1 | max catchment on the watercourse | 0.865 |
| 2 | peak reach gradient | 0.933 |
| 3 | max confinement anywhere on it | 0.943 |
| — | next best (altitude) gains +0.000, stop | — |

Out-of-fold 0.943 against in-sample 0.944 says it is not overfitting. Against zero-star it
manages 0.648 — the same ceiling the reach model hits, for the same reason.

**The scale is anchored on the logged canyons, not on probability.** The fit is a
probability, but at a 0.7% base rate a calibrated probability reads 1% for a perfectly good
canyon, which is unusable — Falls of Barvick, a graded V3 A3 II ★★, came out at 1% while
sitting 621st of 11,677. Promise is therefore reported as position within the logged
distribution: **50 is the median logged descent**, 0 is unremarkable water. Ranking is
identical, being a monotone rescaling. Logged canyons then read median 51, with 63 of 84
at 25 or above and background median 0; Bruar 88 (top 0.3%), Alva 86, Acharn 75, Barvick 37
(top 5.3%). Those checks are asserted in `web/test/search.test.ts`.

The low tail is honest signal about the model's weak spot: the graded canyons it ranks
worst — Allt an Earrochd (0.1 km upstream), High Grain (0.0 km) — are tiny headwater burns.
Upstream *channel length* is near zero for a first-order headwater even where real drainage
exists, so the strongest feature reads blind there. Drainage area from a flow-accumulation
raster would fix it; channel length was the free approximation.

Note *max* confinement, not median: a canyon needs one enclosed section, not uniform
enclosure. And max catchment, which lands at the foot of the descent where the water is
greatest. Ranking by the fit puts 38 graded canyons in the top 250 watercourses, against 9
for peak gradient alone and 19 for catchment alone.

The top of the ranking with nothing logged on it reads as a prospect list:

| promise | watercourse | steep drop | peak | catchment |
| --- | --- | --- | --- | --- |
| 85% | River Tarff | 319 m in 3.0 km | 23% | 50 km |
| 76% | River Affric | 212 m in 0.9 km | 37% | 133 km |
| 67% | Allt a' Choire Ghlais | 514 m in 3.1 km | 47% | 7 km |
| 65% | Allt a' Chaoil-rèidhe | 486 m in 2.0 km | 57% | 8 km |
| 60% | Allt Garbhlach | 496 m in 3.0 km | 48% | 6 km |
| 58% | Water of Unich | 231 m in 1.3 km | 25% | 18 km |
| 41% | Allt a' Ghlomaich | 103 m in 0.9 km | 15% | 18 km |

Several are well-known gorges that simply are not in Canyon Log — Falls of Glomach sits on
Allt a' Ghlomaich, and Water of Ailnack and Allt Garbhlach are documented Cairngorm gorges
— which is the closest thing to external validation available here.

**Independent fixture.** Eight hand-checked commercial descents also surface
(`canyon.validate`, steepest 200 m–1.2 km window on the chain through each venue):

| Venue | Watercourse found | Gradient | Drop |
| --- | --- | --- | --- |
| Acharn (Loch Tay) | Acharn Burn | 33% | 65 m / 200 m |
| Dollar Glen (Ochils) | Burn of Sorrow | 29% | 58 m / 200 m |
| Alva Glen (Ochils) | Alva Burn | 26% | 52 m / 200 m |
| Inchree (Glen Righ) | Abhainn Righ | 25% | 50 m / 200 m |
| Nathrach (Kinlochleven) | Allt Nathrach | 20% | 40 m / 200 m |
| Bruar (Falls of Bruar) | Bruar Water | 19% | 38 m / 200 m |
| Keltneyburn (Aberfeldy) | Allt Mòr | 15% | 29 m / 200 m |
| Keltie (Bracklinn) | Keltie Water | 14% | 28 m / 200 m |

Nationally, 7,279 reaches exceed 15% and 2,555 exceed 25% over 200 m–1.2 km, so the
shortlist needs the secondary filters (catchment, length) to be useful.

## Caveats

- A 50 m DTM smooths narrow gorges and cannot see individual waterfalls; gradient is a
  lead to check on imagery, not a survey. Where a reach was refined the UI says so.
- OS Open Rivers omits the smallest burns, so some steep channels are simply absent.
- Gradient is blind to gorge *narrowness*: Monessie Gorge is a well-known slot that reads
  as 4% and never appears. Confinement would need a cross-valley relief metric, which a
  50 m DEM cannot supply.
- The score is fitted on 91 graded canyons. It reproduces what has been logged, which is
  biased towards accessible and well-known water — it is a prioritiser, not a verdict.
- A long river yields several adjacent qualifying reaches, so Bruar Water can appear three
  times in one shortlist. They are genuinely distinct sections, not duplicates.
- Confinement takes the *lower* of the two banks, so a burn incised into a hillside — one
  side climbing 50 m, the other falling away — scores near zero however deep its slot is.
  Glentarken Burn is the example: 18.5% over 575 m but 3 m of confinement, and no LiDAR
  coverage to check. At 50 m spacing this metric measures landform, not gorge.
- Nothing here knows about access, land ownership, in-stream hazards or water levels.
