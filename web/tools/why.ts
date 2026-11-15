/**
 * Why is a given watercourse missing, or ranked where it is?
 *
 *   node --experimental-strip-types tools/why.ts "Glentarken Burn"
 *
 * Prints every section on it with its rank and badges, and which presets show it.
 */
import { readFile } from 'node:fs/promises';
import { decode, search } from '../src/search.ts';
import { badges, rankText } from '../src/format.ts';
import { ALL, PRESETS, presetQuery } from '../src/presets.ts';
import type { Payload } from '../src/types.ts';

const name = process.argv[2];
if (!name) {
  console.error('usage: why.ts "<watercourse name>"');
  process.exit(2);
}

const meta: Payload = JSON.parse(await readFile('public/data/profiles.json', 'utf8'));
const bin = await readFile('public/data/profiles.bin');
const model = JSON.parse(await readFile('public/data/score.json', 'utf8'));
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
  console.log(`chain ${i}: ${c.name || '(unnamed)'} · ` +
    `${(c.n * meta.spacing / 1000).toFixed(1)} km · ${c.top}→${c.bottom} m · ` +
    `${c.dem ?? '50 m'} · ${c.sections?.length ?? 0} sections`);
  const known = logged.filter((k: { chain: number }) => k.chain === i);
  if (known.length) {
    console.log(`  logged here: ` + known
      .map((k: { name: string; category: string }) => `${k.name} (${k.category})`).join(', '));
  }
}

const mine = search(ALL).candidates.filter((c) => c.name === name);
console.log(`\nsections: ${mine.length}`);
for (const c of mine) {
  console.log(`  ${rankText(c.rank).padEnd(8)} ${(c.gradient * 100).toFixed(0)}% ` +
    `${c.drop.toFixed(0)} m/${c.length} m · ${c.drain.toFixed(1)} km² · ` +
    `conf ${c.confine.toFixed(0)} m · ${badges(c, model).map((b) => b.label).join(', ')}`);
}

console.log('\npreset          sections shown');
for (const [key, p] of Object.entries(PRESETS)) {
  const n = search(presetQuery(p)).candidates.filter((c) => c.name === name).length;
  console.log(`${key.padEnd(15)} ${n} of ${mine.length}`);
}
