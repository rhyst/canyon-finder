/**
 * Dumps group-level features and labels for canyon.rank to fit on.
 *
 *   node --experimental-strip-types tools/export-groups.ts ../data/work/groups.json
 *
 * Runs the browser's own search and grouping code, so the model is fitted on the
 * exact reaches the app shows rather than a Python re-implementation of them.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { decode, search } from '../src/search.ts';
import { buildGroups } from '../src/grouping.ts';
import { isDud, isGraded } from '../src/canyonlog.ts';
import type { KnownCanyon, Payload, Query } from '../src/types.ts';

const out = process.argv[2] ?? '../data/work/groups.json';

// Wide enough that nearly every logged canyon is inside it (95% recall), so the
// fit sees the positives rather than a pre-filtered slice of them.
const QUERY: Query = {
  sort: 'score', minGradient: 0.08, maxGradient: 1, minLength: 200, maxLength: 2000,
  minCatchment: 0, minConfine: 0, minAltitude: 0, maxResults: 1e9,
};

const meta: Payload = JSON.parse(await readFile('public/data/profiles.json', 'utf8'));
const bin = await readFile('public/data/profiles.bin');
const model = JSON.parse(await readFile('public/data/score.json', 'utf8'));
decode(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer,
  meta, model);
const logged: KnownCanyon[] = JSON.parse(
  await readFile('public/data/known.json', 'utf8'),
).canyons;

const groups = buildGroups(search(QUERY).candidates, 'score', meta.spacing);

// A group is labelled by any logged entry whose reach overlaps one of its own.
const overlaps = (k: KnownCanyon, chain: number, i: number, j: number) =>
  k.chain === chain && k.i <= j && k.j >= i;

const rows = groups.map((g) => {
  const hits = logged.filter((k) =>
    g.members.some((c) => overlaps(k, c.chain, c.i, c.j)));
  return {
    key: g.key,
    name: g.name,
    chain: g.chain,
    lon: g.members[0].lon,
    lat: g.members[0].lat,
    dem: g.best.dem,
    label: hits.some(isGraded) ? 'graded'
      : hits.some(isDud) ? 'zero_star'
      : hits.length ? 'other_logged' : 'background',
    logged: hits.map((k) => k.name),
    ...g.features,
  };
});

const counts = rows.reduce<Record<string, number>>((acc, r) => {
  acc[r.label] = (acc[r.label] ?? 0) + 1;
  return acc;
}, {});
console.log(`${groups.length} groups from ${search(QUERY).candidates.length} reaches`);
console.log('labels:', counts);
const missed = logged.filter((k) => isGraded(k)
  && !rows.some((r) => r.chain === k.chain && r.label === 'graded'));
console.log(`graded canyons with no group at this query: ${missed.length}` +
  (missed.length ? ` (${missed.slice(0, 5).map((m) => m.name).join(', ')})` : ''));

await writeFile(out, JSON.stringify({ query: QUERY, groups: rows }));
console.log(`wrote ${out}`);
