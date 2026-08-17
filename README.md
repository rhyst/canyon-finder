# Canyon Finder — Scotland

Find steep watercourse reaches worth looking at for canyoning: how much drop, over how
much channel, with how much water feeding it.

**[Open the map →](https://rhyst.github.io/canyon-finder/)**

## A word of warning

This project was largely **vibe coded** — built quickly with AI assistance, on public
data, by someone who has descended a handful of Scottish canyons. The numbers are
measured, and the known descents are found — but the prospect list is a hypothesis
generator, not a guidebook. Nothing here knows about access rights, land ownership,
in-stream hazards or water levels. Check everything yourself before you walk in.

## Using the map

- Drag the **gradient, length and drainage** sliders; the list and map re-search all of
  Scotland in a fraction of a second, entirely in your browser.
- **Presets** set everything at once — *Calibrated shortlist* is the default and finds
  55 of the 91 graded descents logged on Canyon Log; *Wide net* finds 81.
- Reaches are coloured by steepness. The list groups them by watercourse, best first.
- **Dashed green lines** are canyons people have logged and rated; **grey** are ones
  they visited and reported as not worth it.
- Click a reach or canyon for its elevation profile, drainage and links to OS Maps and
  satellite view. Your filters and position are remembered between visits.

## Where the data comes from

| What | Source | Notes |
| --- | --- | --- |
| Watercourses | OS Open Rivers | 63,210 km of named and unnamed channels, with flow direction. © Ordnance Survey, OGL v3. |
| Elevation | OS Terrain 50 + Scottish public sector LiDAR | 50 m national baseline, refined to ~1 m where LiDAR exists. OGL v3. |
| Known descents | [Canyon Log](https://canyonlog.org/map/) | 146 community-logged Scottish canyons, reproduced with permission. Calibrates the filters and the scoring. |

## Developing locally

```bash
mise install            # node 24 (see mise.toml); python via uv inside pipeline/
mise run install        # pipeline venv + web deps
mise run dev            # vite dev server on http://localhost:5173
mise run test           # web tests + pipeline selftests
```

The compiled dataset is committed in `web/public/data/`, so the app runs with no data
build. Rebuilding it from the public sources is a local pipeline job — see
[docs/architecture.md](docs/architecture.md).

## How the data pipeline works (in plain terms)

1. **Trace the rivers.** The national watercourse network is followed downstream from
   source to sea, producing a continuous profile for each river — the line you draw on
   a map, with a name where one exists.
2. **Sample the terrain.** Each river is measured every 25 m: height, steepness, how
   steep the valley sides are around it, and how much land drains into it (worked out
   by simulating rain flowing downhill across the whole country).
3. **Sharpen where possible.** Where high-resolution LiDAR has been flown, it replaces
   the coarse national elevation along that stretch.
4. **Record the canyons people have descended.** Community logs are matched onto the
   river profiles, so the tool can measure what a rated canyon actually looks like in
   the data.
5. **Fit a score.** The measured descents are compared against ordinary steep burns to
   learn what separates them — then the whole country is compressed into a ~22 MB file
   the site downloads once and searches locally.

Full technical detail, measurements and caveats: [docs/architecture.md](docs/architecture.md).

## Promise, the score on every watercourse

*Promise* is the only custom metric. It ranks watercourses by how much they resemble
the descents people have actually logged, rather than by steepness alone — steepness
finds streams, water and enclosure find canyons.

It reads as a position on the scale set by the logged descents themselves:
**50 is a typical logged descent**, 100 is a dead ringer for the best of them, 0 is
unremarkable water. Promise is a starting point for a weekend, not a verdict — the top
of the list mixes documented gorges nobody has logged with water that genuinely deserves
a look.
