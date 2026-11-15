# Canyon Finder — Great Britain

Find steep watercourse sections worth looking at for canyoning: how much drop, over how
much channel, with how much water feeding it.

**[Open the map →](https://rhyst.github.io/canyon-finder/)**

![Canyon Finder: the map with steep sections coloured by gradient, the watercourse
list, and the elevation profile of a selected section](docs/screenshot.jpg)

## Warning

🚨 VIBE CODED 🚨 

Everything in this project is pure slop! Use for entertainment purposes only! 

## Using the map

- Every river is split where its slope changes. The steep stretches are **sections**:
  fixed pieces of water, each measured and ranked once.
- Each section is ranked against every section in Britain by how much it looks like
  the canyons people have rated: **top 5%** holds about three quarters of them.
- **Tags** say why a section ranks where it does — steep, big drop, falls, confined,
  good water, LiDAR-measured — each shown when it matches a typical rated canyon.
- The **sliders** filter sections by gradient, length, drop, drainage and so on.
  **Presets** set everything at once: *Calibrated shortlist* (the default) is the top
  10% and holds 138 of the 179 worthwhile logged descents; *Top ranked* is the top 2%.
- Sections are coloured by steepness. The list groups them by watercourse, best first.
- **Dashed green lines** are canyons people have logged and rated; **grey** are ones
  they visited and reported as not worth it.
- Click a section or canyon for its elevation profile, drainage and links to OS Maps and
  satellite view. Your filters and position are remembered between visits.
- **LiDAR coverage** outlines where high-resolution elevation exists; outside it, terrain
  comes from the 50 m national model, which smooths gorges.

## Where the data comes from

| What | Source | Notes |
| --- | --- | --- |
| Watercourses | [OS Open Rivers](https://os.uk/products/os-open-rivers) | 63,210 km of named and unnamed channels, with flow direction. © Ordnance Survey, OGL v3. |
| Elevation | [OS Terrain 50](https://os.uk/products/os-terrain-50) + LiDAR from [Scotland](https://remotesensingdata.gov.scot/), [England](https://environment.data.gov.uk/survey) and [Wales](https://datamap.gov.wales/) | 50 m national baseline, refined to 0.5–2 m where LiDAR exists. OGL v3. |
| Dam structures | [OpenStreetMap](https://www.openstreetmap.org/) | Large mapped dams flag likely spillways and embankment slopes. © OpenStreetMap contributors, ODbL. |
| Known descents | [Canyon Log](https://canyonlog.org/map/) | 260 community-logged canyons across Great Britain, reproduced with permission. Their star ratings are what the ranking is fitted on. |
| Visit reports | Community pull requests ([how to add yours](docs/contributing-visits.md)) | Static reports in `data/visits/` — stars (0–4), notes, photos, corrections — merged into `known.json` by the pipeline. |

## Developing locally

```bash
mise install            # node 24 (see mise.toml); python via uv inside pipeline/
mise run install        # pipeline venv + web deps
mise run dev            # vite dev server on http://localhost:5173
mise run test           # web tests + pipeline selftests
```

The compiled dataset is committed in `web/public/data/`, so the app runs with no data
build. Rebuilding it from the public sources is a local pipeline job. See
[docs/architecture.md](docs/architecture.md).

## How the pipeline works

1. **Trace the rivers.** The national watercourse network is followed downstream from
   source to sea, so each river reads as one continuous line with a name where one exists.
2. **Sample the terrain.** Each river is measured every 25 m: height, steepness, how
   steep the valley sides are around it, and how much land drains into it (worked out
   by simulating rain flowing downhill across the whole country).
3. **Sharpen where possible.** Where high-resolution LiDAR has been flown, it replaces
   the coarse national elevation along that stretch.
4. **Flag large dams.** Water beside mapped dam crests at least 100 m long is marked
   so likely spillways and embankment slopes can be hidden without deleting them.
5. **Split into sections.** Each river's long profile is fitted with straight pieces of
   uniform slope, and runs of steep pieces — pools included, if short — become sections.
6. **Record the canyons people have descended.** Community logs are matched onto the
   river profiles, so the tool can measure what a rated canyon actually looks like in
   the data.
7. **Fit the ranking.** Sections holding a rated canyon are compared against all the
   others to learn what separates them. The result is a ~22 MB download the site
   fetches once and filters locally.

Full technical detail, measurements and caveats: [docs/architecture.md](docs/architecture.md).

## The ranking

One model scores every section, from four measurements: how tightly the valley closes
in, how much land drains to it, how far it falls, and its steepest 100 m. The score is
shown as a rank — "top 3%" — not a number on an invented scale.

It was fitted on the sections holding a canyon rated one star or more on Canyon Log.
Tested on canyons it had not seen, the top 1% of sections hold 35% of them, the top 5%
hold 76%, and the top 10% hold 86%. Fitted on Scotland alone it still finds the
canyons of England and Wales, and the reverse.

It says where canyons are, not how good they are: nothing measured here separates a
three-star descent from a dull one. Most of the top of the list is water nobody has
logged, so treat it as a shortlist rather than a guide.
