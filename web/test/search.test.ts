/**
 * Verifies the browser search against the compiled payload.
 * Run: node --experimental-strip-types test/search.test.ts
 */
import assert from 'node:assert';
import { readFile } from 'node:fs/promises';
import { KNOWN_VENUES } from '../src/known.ts';
import { decode, fillCoords, profile, search } from '../src/search.ts';
import { buildGroups, buildRows, candId, findRow, loggedOn } from '../src/grouping.ts';
import { GRADED, ZERO_STAR, covered, isDud, isGraded } from '../src/canyonlog.ts';
import {
  badges, badgesHtml, esc, rankText, safeUrl, sectionLine, watercourseLine,
} from '../src/format.ts';
import { ALL, PRESETS, presetQuery } from '../src/presets.ts';
import type { Candidate, KnownCanyon, Payload, Query, ScoreModel } from '../src/types.ts';

const meta: Payload = JSON.parse(await readFile('public/data/profiles.json', 'utf8'));
const buf = await readFile('public/data/profiles.bin');
const scoreModel: ScoreModel = JSON.parse(await readFile('public/data/score.json', 'utf8'));

const t0 = performance.now();
decode(
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
  meta,
  scoreModel,
);
const loadMs = performance.now() - t0;

const query = (q: Partial<Query> = {}): Query => ({ ...ALL, ...q });

function metres(a: Candidate, lon: number, lat: number) {
  const dx = (a.lon - lon) * Math.cos((lat * Math.PI) / 180) * 111320;
  const dy = (a.lat - lat) * 110540;
  return Math.hypot(dx, dy);
}

let failures = 0;
const check = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${name}\n      ${(err as Error).message}`);
  }
};

console.log(`payload: ${meta.chains.length} chains, ${meta.samples} samples`);

const t1 = performance.now();
const everything = search(ALL).candidates;
const ms = performance.now() - t1;
console.log(`${everything.length} sections · load ${loadMs.toFixed(0)} ms · query ${ms.toFixed(0)} ms`);

check('loading and querying are interactive', () => {
  assert.ok(loadMs < 3000, `load ${loadMs.toFixed(0)} ms`);
  assert.ok(ms < 100, `query ${ms.toFixed(0)} ms`);
});

check('the payload carries sections for every chain', () => {
  assert.ok(meta.chains.every((c) => Array.isArray(c.sections)),
    'run python -m canyon.sections');
  assert.ok(everything.length > 10_000, `${everything.length} sections`);
});

check('every known venue turns up as a section on its own watercourse', () => {
  const missed = KNOWN_VENUES.filter(
    (v) => !everything.some((c) => c.name === v.watercourse && metres(c, v.lon, v.lat) < 5000),
  );
  assert.deepEqual(missed.map((m) => m.name), []);
});

check('gradient and length bounds are respected', () => {
  const q = query({ minGradient: 0.15, maxGradient: 0.6, minLength: 300, maxLength: 1500 });
  const r = search(q).candidates;
  assert.ok(r.length > 0 && r.length < everything.length);
  for (const c of r) {
    assert.ok(c.gradient >= q.minGradient && c.gradient <= q.maxGradient, `gradient ${c.gradient}`);
    assert.ok(c.length >= q.minLength && c.length <= q.maxLength, `length ${c.length}`);
  }
});

check('reported drop and gradient agree with the profile', () => {
  for (const c of everything.slice(0, 500)) {
    const pts = profile(c.chain, c.i, c.j).filter((p) => p.inside);
    const drop = pts[0].z - pts[pts.length - 1].z;
    assert.ok(Math.abs(drop - c.drop) < 0.2, `${c.name}: drop ${drop} vs ${c.drop}`);
    assert.ok(Math.abs(c.gradient - c.drop / c.length) < 1e-9, 'gradient mismatch');
    assert.ok(c.drop >= 10 && c.gradient >= 0.04, `${c.name}: not steep (${c.drop} m)`);
  }
});

check('sections within a chain do not overlap', () => {
  const byChain = new Map<number, Candidate[]>();
  for (const c of everything) byChain.set(c.chain, [...(byChain.get(c.chain) ?? []), c]);
  for (const [chain, cs] of byChain) {
    const sorted = [...cs].sort((a, b) => a.i - b.i);
    for (let k = 1; k < sorted.length; k++) {
      assert.ok(sorted[k].i > sorted[k - 1].j, `chain ${chain} overlap at ${sorted[k].i}`);
    }
  }
});

check('a section is the same water under every query', () => {
  // The point of sections: filters choose among them, they never reshape them.
  const ids = new Set(everything.map((c) => `${c.chain}:${c.i}:${c.j}`));
  for (const p of Object.values(PRESETS)) {
    for (const c of search(presetQuery(p)).candidates) {
      assert.ok(ids.has(`${c.chain}:${c.i}:${c.j}`), `${c.name} reshaped by a preset`);
    }
  }
});

check('coordinates decode to plausible positions', () => {
  for (const c of everything.slice(0, 2000).map(fillCoords)) {
    assert.ok(c.lat > 49.8 && c.lat < 61.1, `lat ${c.lat}`);
    assert.ok(c.lon > -8.7 && c.lon < 1.9, `lon ${c.lon}`);
    assert.ok(c.coords.length >= 2, 'empty geometry');
  }
});

check('drainage filters work at both ends', () => {
  const big = search(query({ minDrain: 20 })).candidates;
  assert.ok(big.length > 0, 'no big-water sections at all');
  for (const c of big) assert.ok(c.drain >= 20, `${c.drain} km2`);

  // A ceiling has to hold at the foot of a section, not just its head:
  // drainage area grows downstream, so the head is the smallest figure on it.
  const small = search(query({ maxDrain: 5 })).candidates;
  assert.ok(small.length > 0, 'no small-water sections at all');
  for (const c of small) assert.ok(c.drainFoot <= 5, `foot ${c.drainFoot} km2 over the ceiling`);
  console.log(`      sections at 20 km2+: ${big.length}, under 5: ${small.length}`);
});

check('the drop floor is respected and monotone', () => {
  const counts = [0, 50, 150, 300].map((d) => {
    const r = search(query({ minDrop: d })).candidates;
    for (const c of r) assert.ok(c.drop >= d, `drop ${c.drop} under the ${d} m floor`);
    return r.length;
  });
  for (let i = 1; i < counts.length; i++) {
    assert.ok(counts[i] < counts[i - 1], `not monotone: ${counts}`);
  }
  console.log(`      sections at 0/50/150/300 m drop: ${counts.join(' / ')}`);
});

const knownDoc = JSON.parse(await readFile('public/data/known.json', 'utf8'));
const logged: KnownCanyon[] = knownDoc.canyons;
const rated = logged.filter((k) => (k.stars ?? 0) >= 1);

check('sections hold nearly every rated canyon', () => {
  const hit = covered(rated, everything);
  const missed = rated.filter((k) => !hit.includes(k));
  console.log(`      ${hit.length}/${rated.length} rated canyons sit on a section; ` +
    `missed: ${missed.map((m) => m.name).slice(0, 6).join(', ') || 'none'}`);
  assert.ok(hit.length / rated.length > 0.9, `${hit.length}/${rated.length}`);
});

check('mapped dams flag the sections at them', () => {
  const at = (chain: number, sample: number) =>
    everything.filter((c) => c.chain === chain && c.i <= sample && c.j >= sample);
  for (const [chain, sample, name] of [
    [7418, 235, 'Upper Glendevon'], [7418, 348, 'Lower Glendevon'], [7427, 107, 'Glensherup'],
  ] as [number, number, string][]) {
    for (const c of at(chain, sample)) assert.ok(c.dam, `${name} was not flagged as a dam`);
  }
  for (const [chain, sample, name] of [
    [7433, 20, 'Castleton Burn'], [7803, 37, 'Allt an Tuim Bhric'],
  ] as [number, number, string][]) {
    for (const c of at(chain, sample)) assert.ok(!c.dam, `${name} was incorrectly flagged`);
  }
  assert.ok(everything.some((c) => c.dam), 'no section is flagged at all');
});

check("Canyon Log's category names still match what the app keys off", () => {
  const seen = new Set(logged.map((k) => k.category));
  assert.ok(seen.has(ZERO_STAR), `no "${ZERO_STAR}" entries — category renamed upstream?`);
  for (const g of GRADED) assert.ok(seen.has(g), `no "${g}" entries`);
  const duds = logged.filter(isDud);
  const graded = logged.filter(isGraded);
  console.log(`      ${graded.length} graded, ${duds.length} zero-star, ${rated.length} rated 1+`);
  assert.ok(duds.length > 0 && graded.length > 0, 'nothing to distinguish');
  // 0 stars is Canyon Log's own category, never a grade that carries no stars.
  for (const k of logged) assert.equal(k.stars === 0, k.category === ZERO_STAR, k.name);
});

/* ---------- ranking ---------- */

const sectionsDoc = JSON.parse(await readFile('../data/work/sections.json', 'utf8'));

check('every derived artifact was built against this payload', () => {
  // known.json addresses the payload by (chain, i, j) and the model was fitted
  // on its sections. Rebuilding the payload renumbers the chains, and nothing
  // about the result looks wrong. See canyon.payload.
  assert.ok(meta.index_id, 'profiles.json carries no index_id');
  for (const [name, doc] of [
    ['known.json', knownDoc],
    ['score.json', scoreModel],
    ['data/work/sections.json', sectionsDoc],
  ] as [string, { index_id?: string }][]) {
    assert.equal(doc.index_id, meta.index_id,
      `${name} was built against ${doc.index_id ?? '(nothing)'}, payload is ${meta.index_id}`);
  }
  assert.equal(sectionsDoc.sections.length, everything.length,
    'sections.json is stale: re-run web:export-sections and pipeline:rank');
});

check('ranks run from the best section to the worst', () => {
  const ranks = everything.map((c) => c.rank).sort((a, b) => a - b);
  assert.ok(Math.abs(ranks[0] - 1 / ranks.length) < 1e-9 && ranks[ranks.length - 1] === 1);
  const byScore = [...everything].sort((a, b) => b.score - a.score);
  for (let k = 1; k < byScore.length; k++) {
    assert.ok(byScore[k].rank > byScore[k - 1].rank, 'rank does not follow score');
  }
  assert.equal(rankText(0.0004), 'top 1%');
  assert.equal(rankText(0.031), 'top 4%');
});

check('the rank finds the rated canyons', () => {
  const held = (share: number) =>
    covered(rated, everything.filter((c) => c.rank <= share)).length;
  const line = [0.01, 0.05, 0.1, 0.25].map((s) => `top ${s * 100}% ${held(s)}`).join(' · ');
  console.log(`      of ${rated.length} rated canyons: ${line}`);
  // In sample, so it must at least match the out-of-fold curve canyon.rank wrote.
  const five = scoreModel.capture.find(([s]) => s === 0.05)![1];
  assert.ok(held(0.05) / rated.length > five - 0.1, `top 5% holds ${held(0.05)}`);
  assert.ok(five > 0.5, `out of fold the top 5% holds only ${five}`);
  assert.ok(scoreModel.auc_other_region > 0.85, `other-region AUC ${scoreModel.auc_other_region}`);
});

check('the rank cut filters, and only removes', () => {
  const top = search(query({ topShare: 0.05 })).candidates;
  assert.ok(Math.abs(top.length / everything.length - 0.05) < 0.002, `${top.length}`);
  for (const c of top) assert.ok(c.rank <= 0.05);
});

check('specific well-known descents rank near the front', () => {
  for (const name of ['Bruar Water', 'Barvick Burn', 'Alva Burn', 'Acharn Burn']) {
    const mine = everything.filter((c) => c.name === name);
    assert.ok(mine.length, `${name} has no section`);
    const best = Math.min(...mine.map((c) => c.rank));
    console.log(`      ${name.padEnd(14)} best section ${rankText(best)}`);
    assert.ok(best < 0.1, `${name} is only in the ${rankText(best)}`);
  }
});

check('the rank beats a single measurement on its own', () => {
  const top = (key: 'score' | 'gradient' | 'drain') => {
    const cut = [...everything].sort((a, b) => b[key] - a[key]).slice(0, 1300);
    return covered(rated, cut).length;
  };
  const [fitted, steep, wet] = [top('score'), top('gradient'), top('drain')];
  console.log(`      rated canyons in the top 1,300 — rank ${fitted}, ` +
    `gradient alone ${steep}, drainage alone ${wet}`);
  assert.ok(fitted > steep && fitted > wet, 'the fit adds nothing');
});

check('badges say what a section has, against the rated canyons', () => {
  const b = scoreModel.badges;
  for (const c of everything.slice(0, 3000)) {
    const labels = badges(c, scoreModel).map((x) => x.label);
    assert.equal(labels.includes('steep'), c.gradient >= b.gradient, `${c.name}: steep`);
    assert.equal(labels.includes('confined'), c.confine >= b.confine, `${c.name}: confined`);
    const water = labels.filter((l) => l.endsWith('water'));
    assert.equal(water.length, 1, `${c.name}: ${water}`);
    assert.ok(labels.includes('lidar') !== labels.includes('50 m model'));
    assert.ok(!/NaN|undefined/.test(badgesHtml(badges(c, scoreModel))), c.name);
  }
  // Without a model the measured facts still show.
  assert.ok(badges(everything[0], null).length >= 1);
});

/* ---------- results list model ---------- */

check('every section on the map resolves to a row in the list', () => {
  const list = search(presetQuery(PRESETS.calibrated)).candidates;
  const groups = buildGroups(list, 'score');

  // Collapsed is the state a fresh search is in: clicking any section on the
  // map must still land somewhere.
  const collapsed = buildRows(groups, new Set());
  const lost = list.filter((c) => findRow(collapsed, candId(c)) < 0);
  assert.deepEqual(lost.map(candId), [], 'unreachable while collapsed');

  const open = buildRows(groups, new Set(groups.map((g) => g.key)));
  for (const c of list) {
    const at = findRow(open, candId(c));
    assert.ok(at >= 0, `${candId(c)} unreachable while expanded`);
    if (groups.find((g) => g.key === `${c.chain}:${c.name}`)!.members.length > 1) {
      assert.ok(open[at].cand, `${candId(c)} resolved to a header, not its own row`);
    }
  }
  console.log(`      ${list.length} sections → ${groups.length} watercourses, ` +
    `${open.length} rows expanded`);
});

check('a watercourse carries its best section and nothing more', () => {
  const groups = buildGroups(everything, 'score');
  for (let k = 0; k < groups.length; k++) {
    const g = groups[k];
    assert.equal(g.best.score, Math.max(...g.members.map((c) => c.score)), g.name);
    assert.ok(Math.abs(g.drop - g.members.reduce((t, c) => t + c.drop, 0)) < 0.5, g.name);
    assert.ok(g.members.every((c, i, a) => i === 0 || a[i - 1].j < c.i), `${g.name}: order`);
    if (k) assert.ok(groups[k - 1].best.score >= g.best.score, 'groups out of order');
  }
});

check('the detail card renders real numbers for every section', () => {
  const groups = buildGroups(everything, 'score');
  const bad: string[] = [];
  for (const g of groups) {
    const lines = [
      watercourseLine(g, { logged: true, loggedNames: ['x'] }),
      watercourseLine(g, { logged: false }),
      ...g.members.map((c) => sectionLine(c, true)),
    ];
    for (const line of lines) {
      if (/NaN|undefined|null|Infinity/.test(line)) bad.push(`${g.name}: ${line}`);
    }
  }
  assert.deepEqual(bad.slice(0, 3), [], 'unrenderable numbers in the detail card');
  const sample = groups.find((g) => g.members.length > 2)!;
  const plain = (s: string) => s.replace(/<[^>]+>/g, '');
  console.log(`      ${sample.name}: ${plain(watercourseLine(sample, { logged: false }))}`);
  console.log(`      best: ${plain(sectionLine(sample.best, true))}`);
});

check('third-party strings cannot inject markup or a script url', () => {
  // Canyon Log is someone else's CMS and the only input here nobody controls.
  assert.equal(esc('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(esc(`"'&`), '&quot;&#39;&amp;');
  assert.equal(safeUrl('javascript:alert(1)'), '', 'javascript: url survived');
  assert.equal(safeUrl('data:text/html,<script>a</script>'), '', 'data: url survived');
  assert.ok(safeUrl('https://canyonlog.org/x').startsWith('https://canyonlog.org/'));

  // And the allowlist must not throw away the real links.
  const dropped = logged.filter((k) => k.url && !safeUrl(k.url));
  assert.equal(dropped.length, 0,
    `${dropped.length} real Canyon Log urls rejected, e.g. ${dropped[0]?.url}`);
});

check('a watercourse is tagged when a logged canyon overlaps or sits just upstream', () => {
  const graded = logged.filter(isGraded);
  const groups = buildGroups(everything, 'drop');

  // Every strictly covered canyon must be tagged. Tags may additionally carry
  // a visit a short way downstream across an OS watercourse-name boundary.
  const id = (k: KnownCanyon) => `${k.chain}:${k.i}:${k.j}`;
  const viaTag = new Set(groups.flatMap((g) => loggedOn(g, graded, meta.spacing)).map(id));
  const viaCount = new Set(covered(graded, everything).map(id));
  assert.ok([...viaCount].every((k) => viaTag.has(k)),
    'a strictly covered canyon is missing its logged tag');

  const holders = (name: string) => groups
    .filter((g) => loggedOn(g, logged, meta.spacing).some((k) => k.name === name))
    .map((g) => g.name);
  assert.ok(holders('Dollar Canyon').includes('Burn of Sorrow'), `${holders('Dollar Canyon')}`);
  assert.ok(holders('Falls of Glomach').length > 0, 'Falls of Glomach is on no watercourse');
});

check('the logged-canyon count responds to every filter', () => {
  const count = (q: Query) => covered(rated, search(q).candidates).length;
  const readings: [string, number][] = [
    ['no filters', count(ALL)],
    ['drainage >= 5 km2', count(query({ minDrain: 5 }))],
    ['drainage <= 5 km2', count(query({ maxDrain: 5 }))],
    ['confinement >= 20 m', count(query({ minConfine: 20 }))],
    ['altitude >= 300 m', count(query({ minAltitude: 300 }))],
    ['gradient >= 25%', count(query({ minGradient: 0.25 }))],
    ['top 5%', count(query({ topShare: 0.05 }))],
  ];
  for (const [what, n] of readings) console.log(`      ${what.padEnd(20)} ${n}/${rated.length}`);

  // Each filter is a restriction, so each must lower the count — one that
  // ignores a filter is the bug this guards.
  const [, open] = readings[0];
  for (const [what, n] of readings.slice(1)) {
    assert.ok(n < open, `${what} left the count unchanged — is it being applied?`);
  }
});

console.log(failures ? `\n${failures} test(s) failed` : '\nall tests passed');
process.exit(failures ? 1 : 0);
