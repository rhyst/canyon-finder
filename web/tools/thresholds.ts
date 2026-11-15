/**
 * What each preset and filter keeps, measured through the app's own search.
 *
 *   node --experimental-strip-types tools/thresholds.ts
 *
 * Recall is counted the way the app counts it — a returned section overlapping
 * a logged descent.
 */
import { readFile } from 'node:fs/promises';
import { decode, search } from '../src/search.ts';
import { buildGroups } from '../src/grouping.ts';
import { covered, isDud, isWorthwhile } from '../src/canyonlog.ts';
import { ALL, PRESETS, presetQuery } from '../src/presets.ts';
import type { KnownCanyon, Payload, Query } from '../src/types.ts';

const meta: Payload = JSON.parse(await readFile('public/data/profiles.json', 'utf8'));
const bin = await readFile('public/data/profiles.bin');
const score = JSON.parse(await readFile('public/data/score.json', 'utf8'));
decode(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer,
  meta, score);
const logged: KnownCanyon[] = JSON.parse(
  await readFile('public/data/known.json', 'utf8'),
).canyons;
const good = logged.filter(isWorthwhile);
const duds = logged.filter(isDud);

function table(title: string, rows: [string, Query][]) {
  console.log(`\n${title}`);
  console.log(`  ${''.padEnd(18)}${'logged kept'.padStart(12)}${'0-star kept'.padStart(12)}` +
    `${'sections'.padStart(10)}${'watercourses'.padStart(14)}${'per logged'.padStart(12)}`);
  for (const [label, q] of rows) {
    const { candidates } = search(q);
    const kept = covered(good, candidates).length;
    console.log(`  ${label.padEnd(18)}${`${kept}/${good.length}`.padStart(12)}` +
      `${`${covered(duds, candidates).length}/${duds.length}`.padStart(12)}` +
      `${candidates.length.toLocaleString().padStart(10)}` +
      `${buildGroups(candidates, 'score').length.toLocaleString().padStart(14)}` +
      `${(candidates.length / Math.max(kept, 1)).toFixed(1).padStart(12)}`);
  }
}

table('every preset as it ships:',
  Object.entries(PRESETS).map(([k, p]) => [k, presetQuery(p)]));
table('rank cut:',
  [1, 0.5, 0.25, 0.1, 0.05, 0.02, 0.01].map((s) => [`top ${s * 100}%`, { ...ALL, topShare: s }]));
table('drainage floor:',
  [0, 0.5, 1, 2, 5, 10, 20].map((v) => [`>= ${v} km2`, { ...ALL, minDrain: v }]));
table('drainage ceiling:',
  [1, 2, 5, 10, 20, 50].map((v) => [`<= ${v} km2`, { ...ALL, maxDrain: v }]));
table('gradient floor:',
  [0.05, 0.08, 0.12, 0.2, 0.3].map((v) => [`>= ${v * 100}%`, { ...ALL, minGradient: v }]));
table('drop floor:',
  [0, 25, 50, 100, 200].map((v) => [`>= ${v} m`, { ...ALL, minDrop: v }]));
