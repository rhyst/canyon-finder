# Canyon Finder — Scotland

Find steep watercourse reaches worth looking at for canyoning: how much drop, over how
much channel, with how much water feeding it.

**[Open the map →](https://rhyst.github.io/canyon-finder/)**

![Canyon Finder: the map with steep reaches coloured by gradient, the watercourse
list, and the elevation profile of a selected reach](docs/screenshot.jpg)

## Warning

🚨 VIBE CODED 🚨 

Everything in this project is pure slop! Use for entertainment purposes only! 

## Using the map

- Drag the **gradient, length and drainage** sliders; the list and map re-search all of
  Scotland in a fraction of a second, entirely in your browser.
- **Presets** set everything at once. *Calibrated shortlist* is the default and finds
  55 of the 91 graded descents logged on Canyon Log; *Wide net* finds 81.
- Reaches are coloured by steepness. The list groups them by watercourse, best first.
- **Dashed green lines** are canyons people have logged and rated; **grey** are ones
  they visited and reported as not worth it.
- Click a reach or canyon for its elevation profile, drainage and links to OS Maps and
  satellite view. Your filters and position are remembered between visits.
- **LiDAR coverage** outlines where high-resolution elevation exists; outside it, terrain
  comes from the 50 m national model, which smooths gorges.

## Where the data comes from

| What | Source | Notes |
| --- | --- | --- |
| Watercourses | [OS Open Rivers](https://os.uk/products/os-open-rivers) | 63,210 km of named and unnamed channels, with flow direction. © Ordnance Survey, OGL v3. |
| Elevation | [OS Terrain 50](https://os.uk/products/os-terrain-50) + [Scottish public sector LiDAR](https://remotesensingdata.gov.scot/) | 50 m national baseline, refined to ~1 m where LiDAR exists. OGL v3. |
| Dam structures | [OpenStreetMap](https://www.openstreetmap.org/) | Large mapped dams flag likely spillways and embankment slopes. © OpenStreetMap contributors, ODbL. |
| Known descents | [Canyon Log](https://canyonlog.org/map/) | 146 community-logged Scottish canyons, reproduced with permission. Calibrates the filters and the scoring. |

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
4. **Flag large dams.** Reaches beside mapped dam crests at least 100 m long are marked
   so likely spillways and embankment slopes can be hidden without deleting them.
5. **Record the canyons people have descended.** Community logs are matched onto the
   river profiles, so the tool can measure what a rated canyon actually looks like in
   the data.
6. **Fit a score.** The measured descents are compared against ordinary steep burns to
   learn what separates them. The result is compressed into a ~22 MB file the site
   downloads once and searches locally.

Full technical detail, measurements and caveats: [docs/architecture.md](docs/architecture.md).

## The promise score

Promise is the only custom metric. It is a score fitted on the logged descents.
Steepness alone does not tell a good canyon from a steep burn: the 0-star duds in the
logged data are steeper than the rated descents. What separates them is water (how
much catchment feeds the reach) and enclosure (how far the valley sides close in),
so the score weights those.

The scale is anchored on the logged descents: **50 is a typical logged descent**, 100
the best of them, 0 unremarkable water. Most of the top of the list is water nobody
has logged, so treat it as a shortlist rather than a guide.
