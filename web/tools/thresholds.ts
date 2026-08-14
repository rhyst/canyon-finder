/**
 * What a drainage-area bound costs, measured through the app's own search.
 *
 *   node --experimental-strip-types tools/thresholds.ts
 *
 * The catchment sliders used to bound upstream channel length. Swapping them to
 * drainage area means every preset's number has to be re-picked, and the only
 * honest way to pick one is to measure what it keeps and what it throws away.
 *
 * Recall is counted the way the app counts it — a returned reach overlapping a
 * logged descent — not by testing each canyon's stored figures against the
 * bounds, which ignores every other filter.
 */
import { readFile } from 'node:fs/promises';
import { decode, search } from '../src/search.ts';
import { buildGroups } from '../src/grouping.ts';
import { covered, isDud, isGraded } from '../src/canyonlog.ts';
import { PRESETS } from '../src/presets.ts';
import type { KnownCanyon, Payload, Query } from '../src/types.ts';

const meta: Payload = JSON.parse(await readFile('public/data/profiles.json', 'utf8'));
const bin = await readFile('public/data/profiles.bin');
const score = JSON.parse(await readFile('public/data/score.json', 'utf8'));
decode(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer,
  meta, score);
const logged: KnownCanyon[] = JSON.parse(
  await readFile('public/data/known.json', 'utf8'),
).canyons;
const graded = logged.filter(isGraded);
const duds = logged.filter(isDud);

const BASE: Query = {
  sort: 'promise', minGradient: 0.08, maxGradient: 1, minLength: 200,
  maxLength: 2000, minDrain: 0, maxDrain: Infinity, minCatchment: 0,
  maxCatchment: Infinity, minConfine: 0, minAltitude: 0,
};

function measure(q: Query) {
  const { candidates } = search(q);
  return {
    reaches: candidates.length,
    groups: buildGroups(candidates, q.sort, meta.spacing).length,
    graded: covered(graded, candidates).length,
    duds: covered(duds, candidates).length,
  };
}

function table(title: string, rows: [string, Query][]) {
  console.log(`\n${title}`);
  console.log(`  ${'bound'.padEnd(16)}${'graded kept'.padStart(12)}` +
    `${'0-star kept'.padStart(12)}${'watercourses'.padStart(14)}${'reaches'.padStart(9)}`);
  for (const [label, q] of rows) {
    const m = measure(q);
    console.log(`  ${label.padEnd(16)}${`${m.graded}/${graded.length}`.padStart(12)}` +
      `${`${m.duds}/${duds.length}`.padStart(12)}` +
      `${m.groups.toLocaleString().padStart(14)}${m.reaches.toLocaleString().padStart(9)}`);
  }
}

// Each preset as it currently ships, so its documented recall can be checked
// rather than trusted, and a drainage floor chosen to preserve it.
const asQuery = (p: Record<string, number | string>, over: Partial<Query>): Query => ({
  ...BASE,
  sort: p.sort as Query['sort'],
  minGradient: Number(p.minGrad) / 100,
  maxGradient: Number(p.maxGrad) / 100,
  minLength: Number(p.minLen),
  maxLength: Number(p.maxLen),
  minDrain: Number(p.minDrain),
  maxDrain: Number(p.maxDrain) >= 200 ? Infinity : Number(p.maxDrain),
  minConfine: Number(p.minConf),
  minAltitude: Number(p.minAlt),
  ...over,
});

console.log('\nevery preset as it ships:');
console.log(`  ${'preset'.padEnd(12)}${'area km2'.padStart(12)}` +
  `${'graded kept'.padStart(12)}${'watercourses'.padStart(14)}${'per graded'.padStart(12)}`);
for (const [key, p] of Object.entries(PRESETS)) {
  const m = measure(asQuery(p, {}));
  const bound = `${p.minDrain}-${Number(p.maxDrain) >= 200 ? '' : p.maxDrain}`;
  console.log(`  ${key.padEnd(12)}${bound.padStart(12)}` +
    `${`${m.graded}/${graded.length}`.padStart(12)}` +
    `${m.groups.toLocaleString().padStart(14)}` +
    `${(m.groups / Math.max(m.graded, 1)).toFixed(1).padStart(12)}`);
}

// How each preset's floor was chosen: the largest one that still holds its
// recall. Re-run this if the payload changes and the presets will need revisiting.
console.log('\nthe largest drainage floor that holds each preset\'s recall:');
console.log(`  ${'preset'.padEnd(12)}${'area km2'.padStart(10)}` +
  `${'graded kept'.padStart(12)}${'watercourses'.padStart(14)}${'per graded'.padStart(12)}`);
const AREAS = [0, 0.25, 0.5, 0.75, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 7, 8, 10, 12, 16, 20];
for (const [key, p] of Object.entries(PRESETS)) {
  const target = measure(asQuery(p, {})).graded;
  let pick = null;
  for (const a of AREAS) {
    const m = measure(asQuery(p, { minCatchment: 0, maxCatchment: Infinity, minDrain: a }));
    if (m.graded >= target) pick = { a, ...m };
    else break;  // recall only falls as the floor rises
  }
  if (!pick) { console.log(`  ${key.padEnd(12)}${'none holds it'.padStart(10)}`); continue; }
  console.log(`  ${key.padEnd(12)}${String(pick.a).padStart(10)}` +
    `${`${pick.graded}/${graded.length}`.padStart(12)}` +
    `${pick.groups.toLocaleString().padStart(14)}` +
    `${(pick.groups / Math.max(pick.graded, 1)).toFixed(1).padStart(12)}`);
}

const FLOORS = [0, 0.25, 0.5, 1, 2, 3, 5, 8, 12, 20, 50];
const CEILINGS = [1, 2, 5, 10, 20, 50, 100, 200, Infinity];

// A floor is the filter that matters: it is what every preset sets.
table('drainage floor, at >=8% over 200-2000 m (the wide net):',
  FLOORS.map((v) => [`>= ${v} km2`, { ...BASE, minDrain: v }] as [string, Query]));

table('drainage floor, at >=12% over 200-600 m (the calibrated shortlist):',
  FLOORS.map((v) => [`>= ${v} km2`,
    { ...BASE, minGradient: 0.12, maxLength: 600, minDrain: v }] as [string, Query]));

// A ceiling is what keeps major rivers out of a small-burn view.
table('drainage ceiling, at >=12% over 200-600 m:',
  CEILINGS.map((v) => [v === Infinity ? 'no ceiling' : `<= ${v} km2`,
    { ...BASE, minGradient: 0.12, maxLength: 600, maxDrain: v }] as [string, Query]));

// The two filters head to head at the same recall. Which measure ranks better is
// a separate question from which filters better, and they do not have to agree.
console.log('\nthe same recall, bought two ways, at >=12% over 200-600 m:');
console.log(`  ${'bound'.padEnd(18)}${'graded kept'.padStart(12)}` +
  `${'watercourses'.padStart(14)}${'per graded'.padStart(12)}`);
const SHORT: Query = { ...BASE, minGradient: 0.12, maxLength: 600 };
const pairs: [string, Query][] = [
  ['channel >= 2 km', { ...SHORT, minCatchment: 2 }],
  ['channel >= 3 km', { ...SHORT, minCatchment: 3 }],
  ['channel >= 5 km', { ...SHORT, minCatchment: 5 }],
  ['area >= 3 km2', { ...SHORT, minDrain: 3 }],
  ['area >= 4 km2', { ...SHORT, minDrain: 4 }],
  ['area >= 5 km2', { ...SHORT, minDrain: 5 }],
  ['area >= 7 km2', { ...SHORT, minDrain: 7 }],
];
for (const [label, q] of pairs) {
  const m = measure(q);
  console.log(`  ${label.padEnd(18)}${`${m.graded}/${graded.length}`.padStart(12)}` +
    `${m.groups.toLocaleString().padStart(14)}` +
    `${(m.groups / Math.max(m.graded, 1)).toFixed(1).padStart(12)}`);
}

// How the old channel-length bounds map onto areas, so a preset can keep its
// intent. Reported from the reaches themselves rather than assumed.
const all = search(BASE).candidates;
console.log('\ndrainage area at each old channel-length bound, over the wide net:');
console.log(`  ${'channel km'.padStart(11)}${'reaches at or above'.padStart(21)}` +
  `${'their drainage p10'.padStart(20)}${'median'.padStart(9)}${'p90'.padStart(9)}`);
for (const km of [0.5, 1, 2, 3, 5, 8, 12, 20]) {
  const kept = all.filter((c) => c.catchment >= km).map((c) => c.drain)
    .sort((a, b) => a - b);
  const at = (f: number) => kept.length ? kept[Math.floor(f * (kept.length - 1))] : NaN;
  console.log(`  ${`>= ${km}`.padStart(11)}${kept.length.toLocaleString().padStart(21)}` +
    `${at(0.1).toFixed(2).padStart(20)}${at(0.5).toFixed(2).padStart(9)}` +
    `${at(0.9).toFixed(1).padStart(9)}`);
}
