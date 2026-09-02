# Contributing a visit report

The map scores candidate canyons from terrain alone. Your experience of a
canyon — did it deliver, what was it like, how long were the drops — is the
missing label the scoring needs. Visit reports are static files in this
repo, added by pull request: no accounts, no backend, just a directory and
a YAML file.

## Walkthrough

1. Fork the repo and check it out.
2. Copy the template and rename the directory to
   `<YYYY-MM-DD>-<kebab-slug>` (your date, then the canyon):

   ```
   cp -r data/visits/_sample data/visits/2026-08-15-allt-arrifish
   ```

3. Fill in `visit.yaml`:

   | Field | Required | Notes |
   | --- | --- | --- |
   | `author` | yes | Your name or handle |
   | `date` | yes | `YYYY-MM-DD` |
   | `location` | yes | `[lon, lat]` — the point closest to the canyon, in Scotland |
   | `stars` | yes | `0` = dud, `1`–`4` = worth it |
   | `name` | no | Used for new entries; ignored when you attach to a logged canyon |
   | `description` | no | What it's like — the details that matter |
   | `grade` | no | Free text (e.g. `WS2 A2`) |
   | `pitches` | no | Number of descents |
   | `highest_pitch_m` | no | Longest single descent |
   | `corrections` | no | `drop_m` / `length_m` — your measurements, if the model's are wrong |
   | `images` | no | Max 6 files, max 400 KB each, jpg/jpeg/png/webp, next to the YAML |
   | `links` | no | http(s) URLs — your write-ups, gallery, etc. |

   Unknown fields are rejected on purpose: if a field name looks like it
   should exist, ask — don't guess.

4. Get `location` right. The report snaps to the nearest watercourse sample;
   beyond 500 m the stage refuses it (the point is not on a mapped channel).
   Drop a pin on [OS Maps](https://osmaps.org) next to the gorge and copy
   the WGS84 coordinates — `[lon, lat]`, not the other way round.
5. Resize photos before committing — this is a static site and every byte
   ships to every visitor. 400 KB at ~1600 px wide is plenty.
6. Regenerate the output and commit **all** of it:

   ```
   mise run pipeline:visits
   git add data/visits web/public/data/known.json web/public/data/visits
   ```

7. Open the PR. CI re-runs the stage and fails if the committed
   `known.json` / image copies don't match what it generates — so never
   hand-edit those; regenerate them.

## What happens to your report

- The stage snaps your location onto the watercourse profiles with the same
  snap the [Canyon Log](https://canyonlog.org/map/) entries use. If a logged
  canyon covers the same reach, your report attaches to that entry;
  otherwise a new entry is created.
- The 0-stars vs 1+ split is the fit's positive/negative label. Scoring
  uses them only once a handful of real visits exist — until then the
  Canyon Log labels carry the weight.

## Fixing or removing a report

Change the files in `data/visits/<slug>/`, re-run `mise run pipeline:visits`,
commit the diff. Deleting the directory removes the report and its images on
the same PR.
