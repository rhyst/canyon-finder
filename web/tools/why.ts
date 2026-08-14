/**
 * Why is a given watercourse missing, or ranked where it is?
 *
 *   node --experimental-strip-types tools/why.ts "Glentarken Burn"
 *
 * Prints every reach the search finds on it, the true steepest window on the
 * chain (to catch the search under-reporting), and its rank under each preset.
 */
import { readFile } from 'node:fs/promises';
import { decode, profile, search } from '../src/search.ts';
import { buildGroups } from '../src/grouping.ts';
import { PRESETS } from '../src/presets.ts';
import type { Payload, Query, SortKey } from '../src/types.ts';

/** What the app shows: watercourses ranked by the preset's sort, then capped. */

const name = process.argv[2];
if (!name) {
  console.error('usage: why.ts "<watercourse name>"');
  process.exit(2);
}

const meta: Payload = JSON.parse(await readFile('public/data/profiles.json', 'utf8'));
const bin = await readFile('public/data/profiles.bin');
const model = JSON.parse(await readFile('public/data/score.json', 'utf8'));
const groupModel = JSON.parse(await readFile('public/data/group-score.json', 'utf8'));
decode(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer,
  meta, model);
const logged = JSON.parse(await readFile('public/data/known.json', 'utf8')).canyons;

const chains = meta.chains
  .map((c, i) => ({ c, i }))
  .filter(({ c }) => c.name === name || c.runs.some(([, n]) => n === name));
if (!chains.length) {
  console.log(`"${name}" is not in the payload at all — either OS Open Rivers does not ` +
    `carry it, or the whole chain fell below the 4% screen floor.`);
  process.exit(0);
}

for (const { c, i } of chains) {
  console.log(`chain ${i}: ${c.name || '(unnamed)'} · ${c.n} samples ` +
    `(${(c.n * meta.spacing / 1000).toFixed(1)} km) · ${c.top}→${c.bottom} m`);
  console.log(`  screen gradients by window: ` + meta.scales
    .map((s, k) => `${s}m ${(c.screen[k] * 100).toFixed(0)}%`).join('  '));
  console.log(`  DEM: ${c.dem ?? '50 m Terrain 50'}`);
  const known = logged.filter((k: { chain: number }) => k.chain === i);
  if (known.length) {
    console.log(`  logged here: ` + known
      .map((k: { name: string; category: string }) => `${k.name} (${k.category})`).join(', '));
  }
}

const loose: Query = {
  sort: 'score', minGradient: 0.05, maxGradient: 1, minLength: 100, maxLength: 2000,
  minCatchment: 0, maxCatchment: Infinity, minConfine: 0, minAltitude: 0,
};
const all = search(loose);
const mine = all.candidates.filter((c) => c.name === name);
console.log(`\nreaches at >=5% over 100-2000 m: ${mine.length}`);
for (const c of mine.slice(0, 10)) {
  console.log(`  ${(c.gradient * 100).toFixed(0)}% ${c.drop.toFixed(0)}m/${c.length}m · ` +
    `steepest 100 m ${(c.steepest * 100).toFixed(0)}% · ${c.catchment.toFixed(1)} km upstream · ` +
    `confinement ${c.confine.toFixed(0)} m · score ${c.score.toFixed(2)}`);
}

// The search should never report less than the true steepest window in band.
for (const { c, i } of chains) {
  const z = profile(i, 0, c.n - 1).map((p) => p.z);
  const minK = Math.round(loose.minLength / meta.spacing);
  const maxK = Math.round(loose.maxLength / meta.spacing);
  let best = { g: 0, i: 0, k: 0 };
  for (let k = minK; k <= maxK; k++) {
    for (let a = 0; a + k < z.length; a++) {
      const g = (z[a] - z[a + k]) / (k * meta.spacing);
      if (g > best.g) best = { g, i: a, k };
    }
  }
  console.log(`  chain ${i} true steepest in band: ${(best.g * 100).toFixed(1)}% ` +
    `(${(z[best.i] - z[best.i + best.k]).toFixed(0)} m / ${best.k * meta.spacing} m)`);
}

console.log('\npreset          shown  rank of watercourses  why not');
for (const [key, p] of Object.entries(PRESETS)) {
  const q: Query = {
    sort: p.sort as SortKey,
    minGradient: Number(p.minGrad) / 100,
    maxGradient: Number(p.maxGrad) / 100,
    minLength: Number(p.minLen),
    maxLength: Number(p.maxLen),
    minCatchment: Number(p.minCatch),
    maxCatchment: p.maxCatch === undefined ? Infinity : Number(p.maxCatch),
    minConfine: Number(p.minConf),
    minAltitude: Number(p.minAlt),
  };
  const groups = buildGroups(search(q).candidates, q.sort, meta.spacing, groupModel);
  const at = groups.findIndex((g) => g.name === name);
  if (at < 0) {
    // Say which filter did it, by relaxing one at a time.
    const relax: [string, Partial<Query>][] = [
      ['catchment', { minCatchment: 0 }],
      ['gradient', { minGradient: 0 }],
      ['length', { minLength: 25, maxLength: 5000 }],
      ['confinement', { minConfine: 0 }],
      ['altitude', { minAltitude: 0 }],
    ];
    const culprits = relax
      .filter(([, patch]) =>
        buildGroups(search({ ...q, ...patch }).candidates, q.sort, meta.spacing, groupModel)
          .some((g) => g.name === name))
      .map(([n]) => n);
    console.log(`${key.padEnd(15)} no                          ` +
      (culprits.length ? `${culprits.join(' or ')} filter` : 'no qualifying reach'));
  } else {
    console.log(`${key.padEnd(15)} yes    ` +
      `${String(at + 1).padStart(5)} of ${groups.length}`);
  }
}
