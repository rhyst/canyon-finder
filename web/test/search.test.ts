/**
 * Verifies the browser search against the compiled payload.
 * Run: node --experimental-strip-types test/search.test.ts
 */
import assert from 'node:assert';
import { readFile } from 'node:fs/promises';
import { KNOWN_VENUES } from '../src/known.ts';
import { decode, fillCoords, profile, search } from '../src/search.ts';
import {
  buildGroups, buildRows, candId, findRow, groupScore,
  type Group, type GroupModel,
} from '../src/grouping.ts';
import { GRADED, ZERO_STAR, covered, isDud, isGraded } from '../src/canyonlog.ts';
import { esc, reachLine, safeUrl, watercourseLine } from '../src/format.ts';
import type { Candidate, KnownCanyon, Payload, Query } from '../src/types.ts';

const meta: Payload = JSON.parse(await readFile('public/data/profiles.json', 'utf8'));
const buf = await readFile('public/data/profiles.bin');
const scoreModel = JSON.parse(await readFile('public/data/score.json', 'utf8'));
decode(
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
  meta,
  scoreModel,
);

const query = (q: Partial<Query> = {}): Query => ({
  sort: 'drop',
  minGradient: 0.1,
  maxGradient: 1,
  minLength: 200,
  maxLength: 1200,
  minDrain: 0,
  maxDrain: Infinity,
  minCatchment: 0,
  maxCatchment: Infinity,
  minConfine: 0,
  minAltitude: 0,
  ...q,
});

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

const t0 = performance.now();
const base = search(query());
const fill = (cs: Candidate[]) => cs.map(fillCoords);
const ms = performance.now() - t0;
console.log(`baseline query: ${base.candidates.length} reaches, ${base.scanned} chains, ${ms.toFixed(0)} ms`);

check('a broad query runs interactively (<400ms)', () => assert.ok(ms < 400, `${ms.toFixed(0)}ms`));

check('every known venue turns up as a steep reach on its own watercourse', () => {
  const missed = KNOWN_VENUES.filter(
    (v) => !base.candidates.some(
      (c) => c.name === v.watercourse && metres(c, v.lon, v.lat) < 5000,
    ),
  );
  assert.deepEqual(missed.map((m) => m.name), []);
});

check('gradient and length bounds are respected', () => {
  for (const q of [query(), query({ minGradient: 0.25, minLength: 400, maxLength: 800 })]) {
    const r = search(q);
    for (const c of r.candidates) {
      assert.ok(c.gradient >= q.minGradient - 1e-9, `gradient ${c.gradient} < ${q.minGradient}`);
      assert.ok(c.gradient <= q.maxGradient + 1e-9, `gradient ${c.gradient} > ${q.maxGradient}`);
      assert.ok(c.length >= q.minLength - 1e-9, `length ${c.length} < ${q.minLength}`);
      assert.ok(c.length <= q.maxLength + 1e-9, `length ${c.length} > ${q.maxLength}`);
    }
  }
});

check('reported drop and gradient agree with the profile', () => {
  for (const c of base.candidates.slice(0, 200)) {
    const pts = profile(c.chain, c.i, c.j).filter((p) => p.inside);
    const drop = pts[0].z - pts[pts.length - 1].z;
    assert.ok(Math.abs(drop - c.drop) < 0.2, `${c.name}: drop ${drop} vs ${c.drop}`);
    assert.ok(Math.abs(c.gradient - c.drop / c.length) < 1e-9, 'gradient mismatch');
  }
});

check('candidates within a chain do not overlap', () => {
  const byChain = new Map<number, Candidate[]>();
  for (const c of base.candidates) {
    byChain.set(c.chain, [...(byChain.get(c.chain) ?? []), c]);
  }
  for (const [chain, cs] of byChain) {
    const sorted = [...cs].sort((a, b) => a.i - b.i);
    for (let k = 1; k < sorted.length; k++) {
      assert.ok(sorted[k].i >= sorted[k - 1].j, `chain ${chain} overlap at ${sorted[k].i}`);
    }
  }
});

check('stricter gradient never yields more reaches', () => {
  const counts = [0.08, 0.15, 0.25, 0.4].map((g) => search(query({ minGradient: g })).candidates.length);
  for (let i = 1; i < counts.length; i++) {
    assert.ok(counts[i] <= counts[i - 1], `${counts}`);
  }
  console.log(`      reaches at 8/15/25/40%: ${counts.join(' / ')}`);
});

check('the prescreen does not hide reaches', () => {
  // Brute force one region against the screened search.
  const strict = query({ minGradient: 0.2, minLength: 200, maxLength: 400 });
  const found = new Set(search(strict).candidates.map((c) => `${c.chain}:${c.i}`));
  let brute = 0;
  for (let ci = 0; ci < meta.chains.length; ci++) {
    const c = meta.chains[ci];
    if (Math.max(...c.screen) < 0.1) continue;
    for (let i = 0; i + 8 < c.n; i++) {
      const p = profile(ci, i, i + 8);
      const seg = p.filter((s) => s.inside);
      const g = (seg[0].z - seg[seg.length - 1].z) / 200;
      if (g >= 0.2) brute++;
    }
  }
  assert.ok(found.size > 0 && brute > 0, 'nothing to compare');
  console.log(`      screened found ${found.size} reaches; brute force saw ${brute} steep windows`);
});

check('coordinates decode to plausible Scottish positions', () => {
  for (const c of fill(base.candidates.slice(0, 2000))) {
    assert.ok(c.lat > 54.5 && c.lat < 61.1, `lat ${c.lat}`);
    assert.ok(c.lon > -8.7 && c.lon < 0.2, `lon ${c.lon}`);
    assert.ok(c.coords.length >= 2, 'empty geometry');
  }
});

check('drainage filters work at both ends', () => {
  const big = search(query({ minDrain: 20 }));
  assert.ok(big.candidates.length > 0, 'no big-water reaches at all');
  for (const c of big.candidates) assert.ok(c.drain >= 20, `${c.drain} km2`);

  // A ceiling has to hold at the foot of a reach, not just its head: drainage
  // area grows downstream, so the head is the smallest figure on it.
  const small = search(query({ maxDrain: 5 }));
  assert.ok(small.candidates.length > 0, 'no small-water reaches at all');
  for (const c of small.candidates) {
    assert.ok(c.drain <= 5, `head ${c.drain} km2 over the 5 km2 ceiling`);
    assert.ok(profile(c.chain, c.i, c.j).length > 0);
  }
  const window = search(query({ minDrain: 2, maxDrain: 8 }));
  for (const c of window.candidates) {
    assert.ok(c.drain >= 2 && c.drain <= 8, `${c.drain} outside 2-8 km2`);
  }
  console.log(`      reaches at 20 km2+: ${big.candidates.length}, ` +
    `under 5: ${small.candidates.length}, 2-8: ${window.candidates.length}`);

  // The channel-length bound stays in the engine, unexposed, so the two ways of
  // measuring water can be compared — tools/thresholds.ts relies on it.
  const byChannel = search(query({ minCatchment: 20 }));
  assert.ok(byChannel.candidates.length > 0, 'the channel bound stopped working');
  for (const c of byChannel.candidates) assert.ok(c.catchment >= 20, `${c.catchment}`);
});

const logged: KnownCanyon[] = JSON.parse(
  await readFile('public/data/known.json', 'utf8'),
).canyons;

check('the search recovers most logged canyons', () => {
  const wide = search(query({ minGradient: 0.08, minLength: 200, maxLength: 2000 }));
  const byChain = new Map<number, Candidate[]>();
  for (const c of wide.candidates) {
    byChain.set(c.chain, [...(byChain.get(c.chain) ?? []), c]);
  }
  // A hit means a candidate overlaps the reach the logged canyon sits on.
  const hit = logged.filter((k) =>
    (byChain.get(k.chain) ?? []).some((c) => c.i <= k.j && c.j >= k.i));
  const recall = hit.length / logged.length;
  console.log(`      ${hit.length}/${logged.length} logged canyons recovered ` +
    `at 8% over 200-2000 m (${(recall * 100).toFixed(0)}%)`);
  const missed = logged.filter((k) => !hit.includes(k));
  console.log(`      steepest miss: ` + (missed.length
    ? missed.map((m) => `${m.name} ${(m.gradient * 100).toFixed(0)}%`)
        .slice(0, 4).join(', ')
    : 'none'));
  assert.ok(recall > 0.8, `recall ${(recall * 100).toFixed(0)}%`);
});

check("Canyon Log's category names still match what the app keys off", () => {
  const seen = new Set(logged.map((k) => k.category));
  assert.ok(seen.has(ZERO_STAR), `no "${ZERO_STAR}" entries — category renamed upstream?`);
  for (const g of GRADED) assert.ok(seen.has(g), `no "${g}" entries`);
  const duds = logged.filter(isDud);
  const graded = logged.filter(isGraded);
  console.log(`      ${graded.length} graded, ${duds.length} zero-star, ` +
    `${logged.length - graded.length - duds.length} other of ${logged.length}`);
  assert.ok(duds.length > 0 && graded.length > 0, 'nothing to distinguish');
});

check('the prospect score ranks logged canyons above the pool', () => {
  const wide = search(query({ minGradient: 0.08, minLength: 200, maxLength: 600 }));
  const scores = wide.candidates.map((c) => c.score).sort((a, b) => a - b);
  const cut = scores[Math.floor(scores.length * 0.98)];
  const graded = logged.filter(isGraded);
  const hits = graded.filter((k) => wide.candidates.some(
    (c) => c.chain === k.chain && c.i <= k.j && c.j >= k.i && c.score >= cut));
  console.log(`      top 2% by score contains ${hits.length}/${graded.length} graded canyons`);
  assert.ok(hits.length / graded.length > 0.25, `${hits.length}/${graded.length}`);
});



/* ---------- results list model ---------- */

check('every reach on the map resolves to a row in the list', () => {
  const q = query({ minGradient: 0.12, minLength: 200, maxLength: 600, minDrain: 4 });
  const list = search(q).candidates;
  const groups = buildGroups(list, 'score', meta.spacing);

  // Collapsed is the state a fresh search is in: clicking any reach on the map
  // must still land somewhere, including watercourses holding a single reach.
  const collapsed = buildRows(groups, new Set());
  const lost = list.filter((c) => findRow(collapsed, candId(c)) < 0);
  assert.deepEqual(lost.map(candId), [], 'unreachable while collapsed');

  // Expanded, every reach gets its own row.
  const all = new Set(groups.map((g) => g.key));
  const open = buildRows(groups, all);
  for (const c of list) {
    const at = findRow(open, candId(c));
    assert.ok(at >= 0, `${candId(c)} unreachable while expanded`);
    if (groups.find((g) => g.key === `${c.chain}:${c.name}`)!.members.length > 1) {
      assert.ok(open[at].cand, `${candId(c)} resolved to a header, not its own row`);
    }
  }
  const multi = groups.filter((g) => g.members.length > 1);
  console.log(`      ${list.length} reaches → ${groups.length} groups ` +
    `(${multi.length} with several reaches), ${collapsed.length} rows collapsed, ` +
    `${open.length} expanded`);
});

check('group summaries add up', () => {
  const groups = buildGroups(search(query()).candidates, 'drop', meta.spacing);
  for (const g of groups) {
    const sum = g.members.reduce((t, c) => t + c.drop, 0);
    assert.ok(Math.abs(sum - g.steepDrop) < 0.5, `${g.name}: steep drop`);
    assert.ok(g.spanLength >= g.steepLength - 1e-6, `${g.name}: span shorter than its reaches`);
    assert.ok(g.spanDrop >= g.steepDrop - 0.5, `${g.name}: span drop below steep drop`);
    assert.ok(g.members.every((c, i, a) => i === 0 || a[i - 1].j <= c.i), `${g.name}: order`);
  }
});



/* ---------- group-level ranking ---------- */

const groupModel: GroupModel = JSON.parse(
  await readFile('public/data/group-score.json', 'utf8'),
);
const exported = JSON.parse(await readFile('../data/work/groups.json', 'utf8')).groups;

check('the browser reproduces the fitted group ranking', () => {
  // groupScore only reads .features, so the exported rows can stand in for groups.
  const scored = exported.map((r: Record<string, number | string>) => ({
    label: r.label as string,
    p: groupScore({ features: r } as unknown as Group, groupModel),
  })).sort((a: { p: number }, b: { p: number }) => b.p - a.p);

  assert.ok(scored.every((s: { p: number }) => s.p >= 0 && s.p <= 1), 'not a probability');
  const graded = (n: number) =>
    scored.slice(0, n).filter((s: { label: string }) => s.label === 'graded').length;
  const zero = (n: number) =>
    scored.slice(0, n).filter((s: { label: string }) => s.label === 'zero_star').length;
  console.log(`      top 50/250/500 watercourses hold ${graded(50)}/${graded(250)}/` +
    `${graded(500)} of the graded canyons, ${zero(50)}/${zero(250)}/${zero(500)} zero-star`);

  // canyon.rank reported these from the Python fit; the TS transform must agree.
  assert.equal(graded(50), 16, 'top-50 graded recall differs from the Python fit');
  assert.equal(graded(500), 49, 'top-500 graded recall differs from the Python fit');
});

check('logged canyons sit high on the promise scale', () => {
  const score = (r: Record<string, number | string>) =>
    groupScore({ features: r } as unknown as Group, groupModel) * 100;
  const graded = exported.filter((r: { label: string }) => r.label === 'graded');
  const promise = graded.map(score).sort((a: number, b: number) => a - b);
  const median = promise[Math.floor(promise.length / 2)];
  const bg = exported.filter((r: { label: string }) => r.label === 'background').map(score);
  const bgMedian = [...bg].sort((a, b) => a - b)[Math.floor(bg.length / 2)];
  console.log(`      logged canyons: median ${median.toFixed(0)}, ` +
    `p10 ${promise[Math.floor(promise.length * 0.1)].toFixed(0)}, ` +
    `${promise.filter((p: number) => p >= 25).length}/${promise.length} at 25+ · ` +
    `background median ${bgMedian.toFixed(0)}`);

  // The scale is anchored on the logged canyons, so the median must land mid-scale
  // and the great majority must clear "unremarkable".
  assert.ok(Math.abs(median - 50) < 6, `median logged canyon reads ${median.toFixed(0)}`);
  assert.ok(promise.filter((p: number) => p >= 25).length / promise.length > 0.7,
    'too many logged canyons score low');
  assert.ok(bgMedian < 5, `background median ${bgMedian.toFixed(0)} is not low`);
});

check('specific well-known descents rank in the top few percent', () => {
  const scored = exported
    .map((r: Record<string, number | string>) => ({
      name: r.name as string,
      p: groupScore({ features: r } as unknown as Group, groupModel),
    }))
    .sort((a: { p: number }, b: { p: number }) => b.p - a.p);
  // Named venues we have checked by hand; each should be near the front.
  for (const name of ['Bruar Water', 'Barvick Burn', 'Alva Burn', 'Acharn Burn']) {
    const at = scored.findIndex((s: { name: string }) => s.name === name);
    assert.ok(at >= 0, `${name} missing from the ranking`);
    const pct = (at + 1) / scored.length * 100;
    console.log(`      ${name.padEnd(14)} rank ${at + 1} of ${scored.length} ` +
      `(top ${pct.toFixed(1)}%), promise ${(scored[at].p * 100).toFixed(0)}`);
    assert.ok(pct < 10, `${name} is only in the top ${pct.toFixed(1)}%`);
  }
});

check('promise beats a single feature on its own', () => {
  const rank = (score: (r: Record<string, number>) => number) => {
    const s = exported
      .map((r: Record<string, number | string>) => ({
        label: r.label as string,
        p: score(r as Record<string, number>),
      }))
      .sort((a: { p: number }, b: { p: number }) => b.p - a.p);
    return s.slice(0, 250).filter((x: { label: string }) => x.label === 'graded').length;
  };
  const fitted = rank((r) => groupScore({ features: r } as unknown as Group, groupModel));
  const bySteepness = rank((r) => r.peak_gradient);
  const byWater = rank((r) => r.catchment_km);
  console.log(`      graded canyons in the top 250 — fitted ${fitted}, ` +
    `peak gradient alone ${bySteepness}, catchment alone ${byWater}`);
  assert.ok(fitted > bySteepness && fitted > byWater, 'the fit adds nothing');
});



check('a looser query never shows fewer watercourses than a stricter one', () => {
  // The bug this guards: results used to be capped at 1000 reaches before being
  // grouped, so "wide net" displayed fewer rows than "calibrated shortlist" —
  // rivers carrying many reaches each ate the quota. Nothing is capped now.
  const shown = (q: Query) =>
    buildGroups(search(q).candidates, q.sort, meta.spacing, groupModel).length;
  const strict = query({ sort: 'promise', minGradient: 0.12, minLength: 200,
    maxLength: 600, minDrain: 4 });
  const loose = query({ sort: 'promise', minGradient: 0.08, minLength: 200,
    maxLength: 2000, minDrain: 1 });
  const [a, b] = [shown(strict), shown(loose)];
  console.log(`      calibrated shows ${a} watercourses, wide net ${b}`);
  assert.ok(b >= a, `wide net shows ${b} but calibrated shows ${a}`);

  // Every reach the strict query finds must still be covered by the loose one.
  // Compared by channel position, not by name: a longer maxLength lets a reach
  // grow upstream past a name change, which relabels the group without losing
  // the water.
  const strictReaches = search(strict).candidates;
  const looseByChain = new Map<number, Candidate[]>();
  for (const c of search(loose).candidates) {
    looseByChain.set(c.chain, [...(looseByChain.get(c.chain) ?? []), c]);
  }
  const uncovered = strictReaches.filter((c) =>
    !(looseByChain.get(c.chain) ?? []).some((l) => l.i <= c.j && l.j >= c.i));
  console.log(`      ${strictReaches.length} strict reaches, ` +
    `${uncovered.length} not covered by the loose query`);
  assert.deepEqual(uncovered.slice(0, 3).map((c) => `${c.name} ${c.i}`), [],
    'reaches vanish when loosening');
});



check('the detail card renders real numbers for every watercourse', () => {
  const groups = buildGroups(
    search(query({ sort: 'promise', minGradient: 0.1, minLength: 200, maxLength: 1200 }))
      .candidates,
    'promise', meta.spacing, groupModel,
  );
  const bad: string[] = [];
  for (const g of groups) {
    const lines = [
      watercourseLine(g, { promise: groupScore(g, groupModel), logged: true }),
      watercourseLine(g, { promise: null, logged: false }),
      ...g.members.map(reachLine),
    ];
    for (const line of lines) {
      if (/NaN|undefined|null|Infinity/.test(line)) bad.push(`${g.name}: ${line}`);
    }
  }
  assert.deepEqual(bad.slice(0, 3), [], 'unrenderable numbers in the detail card');

  const sample = groups.find((g) => g.members.length > 3)!;
  console.log(`      ${sample.name}: ${watercourseLine(sample,
    { promise: groupScore(sample, groupModel), logged: false }).replace(/<[^>]+>/g, '')}`);
  console.log(`      reach 1: ${reachLine(sample.members[0])}`);
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
  console.log(`      ${logged.filter((k) => k.url).length} logged urls all pass the allowlist`);
});

check('the logged-canyon count responds to every filter', () => {
  const graded = logged.filter(isGraded);
  const count = (q: Query) => covered(graded, search(q).candidates).length;
  const base = query({ minGradient: 0.08, minLength: 200, maxLength: 2000 });

  const readings: [string, number][] = [
    ['no filters', count(base)],
    ['drainage >= 5 km2', count({ ...base, minDrain: 5 })],
    ['drainage <= 5 km2', count({ ...base, maxDrain: 5 })],
    ['confinement >= 20 m', count({ ...base, minConfine: 20 })],
    ['altitude >= 300 m', count({ ...base, minAltitude: 300 })],
    ['gradient >= 25%', count({ ...base, minGradient: 0.25 })],
  ];
  for (const [what, n] of readings) console.log(`      ${what.padEnd(20)} ${n}/${graded.length}`);

  // Each filter is a restriction, so none may raise the count, and each of these
  // must actually move it — a count that ignores a filter is the bug this guards.
  const [, open] = readings[0];
  for (const [what, n] of readings.slice(1)) {
    assert.ok(n <= open, `${what} raised the count`);
    assert.ok(n < open, `${what} left the count unchanged — is it being applied?`);
  }
});

console.log(failures ? `\n${failures} test(s) failed` : '\nall tests passed');
process.exit(failures ? 1 : 0);
