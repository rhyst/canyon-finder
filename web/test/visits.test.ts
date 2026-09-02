/**
 * Verifies the visit-report display logic against the compiled known.json:
 * the Canyon Log vocabulary extended to visits, the reported-vs-measured
 * numbers, and the escaping/allowlisting of community text before it is
 * rendered into the detail card.
 * Run: node --experimental-strip-types test/visits.test.ts
 */
import assert from 'node:assert';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { KnownCanyon, VisitReport } from '../src/types.ts';
import {
  ZERO_STAR, VISIT_SOURCE, isDud, isGraded, isWorthwhile,
  reportedStats, visitReportsHtml, visitStars,
} from '../src/canyonlog.ts';
import { esc, safeUrl } from '../src/format.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const knownDoc = JSON.parse(await readFile(join(root, 'public/data/known.json'), 'utf8'));
const canyons: KnownCanyon[] = knownDoc.canyons;

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

const entry = (over: Partial<KnownCanyon>): KnownCanyon => ({
  name: 'Test Burn', grade: '', category: 'Visit', url: '', note: '',
  watercourse: 'Test Burn', snap_m: 0, chain: 0, i: 0, j: 10,
  gradient: 0.1, drop: 20, length: 200, dem: '50 m', lon: 0, lat: 0,
  coords: [[0, 0], [0.001, 0]], ...over,
});
const visit = (over: Partial<VisitReport>): VisitReport =>
  ({ author: 'A. Climber', date: '2026-08-15', stars: 3, ...over });

check('the vocabulary extends Canyon Log vocabulary without changing it', () => {
  assert.ok(isDud(entry({ category: ZERO_STAR })), '0 Stars stays a dud');
  assert.ok(!isDud(entry({ category: 'Moderate' })), 'graded is not a dud');
  assert.ok(isDud(entry({ visits: [visit({ stars: 0 }), visit({ stars: 0 })] })),
    'all-zero visits are a dud');
  assert.ok(!isDud(entry({ visits: [visit({ stars: 0 }), visit({ stars: 1 })] })),
    'one worthwhile visit rescues the entry');
  assert.ok(!isDud(entry({ visits: [visit({ stars: 2 })] })), 'a 2 is not a dud');
  assert.ok(!isWorthwhile(entry({ visits: [visit({ stars: 0 })] })),
    'zeros are not worthwhile');
  assert.ok(isWorthwhile(entry({ visits: [visit({ stars: 1 })] })), 'a 1 is worthwhile');
  assert.ok(!isWorthwhile(entry({})), 'no visits is not worthwhile');
  assert.ok(!isGraded(entry({ source: VISIT_SOURCE })),
    'a visit entry is not a graded descent — the counter must ignore it');
  assert.ok(isGraded(entry({ category: 'Basic' })), 'graded stays graded');
});

check('the star tag speaks Canyon Log vocabulary', () => {
  assert.deepEqual(visitStars(visit({ stars: 0 })), { text: 'not worth it', dud: true });
  assert.deepEqual(visitStars(visit({ stars: 1 })).text, '★');
  assert.deepEqual(visitStars(visit({ stars: 4 })).text, '★★★★');
  assert.ok(!visitStars(visit({ stars: 4 })).dud);
});

check('reported numbers fall back to the pipeline measurements', () => {
  const k = entry({});
  assert.deepEqual(
    reportedStats(k),
    { gradient: 0.1, drop: 20, length: 200, corrected: false });

  const c = entry({ visits: [visit({ corrections: { drop_m: 30, length_m: 150 } })] });
  assert.deepEqual(
    reportedStats(c),
    { gradient: 0.2, drop: 30, length: 150, corrected: true });

  const half = entry({ visits: [visit({ corrections: { drop_m: 40 } })] });
  assert.deepEqual(reportedStats(half),
    { gradient: 0.2, drop: 40, length: 200, corrected: true });

  const later = entry({ visits: [
    visit({ stars: 2 }),
    visit({ stars: 2, corrections: { length_m: 400 } }),
  ]});
  assert.ok(reportedStats(later).corrected, 'a later report corrections apply');
  assert.deepEqual(reportedStats(later).gradient, 0.05);

  const flat = entry({ length: 0, visits: [visit({ corrections: { drop_m: 5 } })] });
  assert.equal(reportedStats(flat).gradient, 0, 'zero length must not yield NaN');
  assert.ok(!Number.isNaN(reportedStats(flat).gradient));
});

check('community text never reaches the card unescaped', () => {
  assert.equal(esc('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(esc('A & B'), 'A &amp; B');
  assert.equal(safeUrl('javascript:alert(1)'), '', 'javascript: link survived');
  assert.equal(safeUrl('data:text/html,<script>a</script>'), '', 'data: link survived');
  assert.ok(safeUrl('https://example.org/notes').startsWith('https://example.org/'));

  // And the report card itself: hostile fields render inert.
  const k = entry({ visits: [{
    author: '<b onclick=alert(1)>Evil</b>',
    date: '2026-08-15',
    stars: 0,
    description: 'line one\n<script>alert(2)</script>',
    grade: '"WS" onmouseover=alert(3)',
    links: ['javascript:alert(4)', 'https://safe.example/notes'],
    images: [{ file: 'a.png', caption: 'x"y', url: '/data/visits/slug/a.png' }],
  }]});
  const html = visitReportsHtml(k);
  assert.ok(html.includes('&lt;b onclick=alert(1)&gt;Evil&lt;/b&gt;'), 'author not escaped');
  assert.ok(!/<b onclick|<script/.test(html), 'live markup survived');
  assert.ok(!/href="javascript:/.test(html), 'javascript: link rendered');
  assert.ok(html.includes('https://safe.example/notes'), 'the safe link was dropped');
  assert.ok(html.includes('&lt;script&gt;alert(2)&lt;/script&gt;'), 'description not escaped');
  assert.ok(html.includes('&quot;WS&quot; onmouseover=alert(3)'), 'grade quotes not escaped');
  assert.ok(html.includes('line one<br>'), 'newlines lost');
  assert.ok(html.includes('not worth it'), 'the 0-star tag is missing');
});

check('known.json visit reports honour the pipeline contract', () => {
  const withVisits = canyons.filter((k) => (k.visits?.length ?? 0) > 0);
  const visitEntries = canyons.filter((k) => k.source === VISIT_SOURCE);
  for (const k of visitEntries) {
    assert.equal(k.category, 'Visit', `${k.name}: visit entry with a graded category`);
    assert.ok(k.visits?.length, `${k.name}: visit entry without reports`);
  }
  console.log(`      ${withVisits.length} entries carry reports, ` +
    `${visitEntries.length} are their own entries`);
  for (const k of withVisits) {
    for (const v of k.visits!) {
      assert.ok(Number.isInteger(v.stars) && v.stars >= 0 && v.stars <= 4,
        `${k.name}: stars ${String(v.stars)}`);
      assert.match(v.date, /^\d{4}-\d{2}-\d{2}$/, `${k.name}: date ${v.date}`);
      assert.ok(v.author.length > 0, `${k.name}: empty author`);
      for (const im of v.images ?? []) {
        assert.match(im.url, /^\/data\/visits\/[\w-]+\/[\w.-]+$/, `${k.name}: ${im.url}`);
        assert.ok(existsSync(join(root, 'public', im.url)),
          `${k.name}: image missing on disk: ${im.url}`);
      }
      const dropped = (v.links ?? []).filter((l) => !safeUrl(l));
      assert.deepEqual(dropped, [], `${k.name}: non-http(s) link: ${dropped}`);
    }
  }
});

console.log(failures ? `\n${failures} test(s) failed` : '\nall tests passed');
process.exit(failures ? 1 : 0);
