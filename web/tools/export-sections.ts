/**
 * Dumps every section with its measurements and labels for canyon.rank to fit on.
 *
 *   node --experimental-strip-types tools/export-sections.ts ../data/work/sections.json
 *
 * Runs the browser's own measuring code, so the model is fitted on the exact
 * numbers the app shows rather than a Python re-implementation of them.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { decode, search } from '../src/search.ts';
import { ALL } from '../src/presets.ts';
import type { KnownCanyon, Payload } from '../src/types.ts';

const out = process.argv[2] ?? '../data/work/sections.json';

const meta: Payload = JSON.parse(await readFile('public/data/profiles.json', 'utf8'));
const bin = await readFile('public/data/profiles.bin');
decode(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer, meta);
const logged: KnownCanyon[] = JSON.parse(
  await readFile('public/data/known.json', 'utf8'),
).canyons;

const byChain = new Map<number, KnownCanyon[]>();
for (const k of logged) byChain.set(k.chain, [...(byChain.get(k.chain) ?? []), k]);

const rows = search(ALL).candidates.map((c) => {
  const hits = (byChain.get(c.chain) ?? []).filter((k) => k.i <= c.j && k.j >= c.i);
  const { coords: _coords, score: _score, rank: _rank, ...features } = c;
  return {
    ...features,
    logged: hits.map((k) => k.name),
    // Best rating on it; null when nothing rated sits here.
    stars: hits.reduce<number | null>((m, k) =>
      (k.stars ?? null) === null ? m : Math.max(m ?? 0, k.stars!), null),
  };
});

const tally = (f: (r: typeof rows[number]) => boolean) => rows.filter(f).length;
console.log(`${rows.length} sections: ${tally((r) => (r.stars ?? 0) >= 1)} hold a rated canyon, ` +
  `${tally((r) => r.stars === 0)} a 0-star report, ` +
  `${tally((r) => r.logged.length > 0 && r.stars === null)} an unrated one`);
const missed = logged.filter((k) => (k.stars ?? 0) >= 1
  && !rows.some((r) => r.chain === k.chain && r.i <= k.j && r.j >= k.i));
console.log(`rated canyons on no section: ${missed.length}` +
  (missed.length ? ` (${missed.slice(0, 8).map((m) => m.name).join(', ')})` : ''));

// canyon.rank must be able to tell whether these rows describe the payload it
// is pointed at.
await writeFile(out, JSON.stringify({ index_id: meta.index_id, sections: rows }));
console.log(`wrote ${out}`);
