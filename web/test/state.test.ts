/**
 * Verifies session persistence: what an older version of the app wrote to
 * localStorage is validated before being trusted, saves merge rather than
 * clobber, and preset matching recognises the slider sets it was measured from.
 * Run: node --experimental-strip-types test/state.test.ts
 */
import assert from 'node:assert';
import { PRESETS } from '../src/presets.ts';
import { loadState, presetFor, saveState } from '../src/state.ts';

// A localStorage stand-in: the module only needs getItem/setItem.
const store = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};

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

const put = (doc: unknown) => store.set('canyon-finder/v1', JSON.stringify(doc));

check('an empty store gives an empty state', () => {
  store.clear();
  assert.deepEqual(loadState(), {});
});

check('corrupt or foreign contents are dropped, not thrown at the map', () => {
  for (const bad of ['not json', '42', '"a string"', '[1, 2]', 'null',
    { view: { center: [90, 90], zoom: 6 } },              // not Scotland
    { view: { center: [-4.6, 56.9], zoom: 99 } },         // unshowable zoom
    { view: { center: [-4.6 ], zoom: 6 } },               // short center
    { view: { center: [-4.6, NaN, 0], zoom: 6 } },        // long center
    { view: 'somewhere' },
    { filters: { minGrad: 12 } },                        // only non-string values
    { selected: { kind: 'canyon', id: '1:2' } },          // unknown kind
    { selected: { kind: 'reach', id: 42 } },              // non-string id
    { selected: { kind: 'reach' } },
  ]) {
    put(bad);
    assert.deepEqual(loadState(), {}, `accepted ${JSON.stringify(bad)}`);
  }
});

check('invalid filter values are dropped per entry, valid ones kept', () => {
  put({ filters: { minGrad: 12, sort: 'promise', maxLen: '600' } });
  assert.deepEqual(loadState().filters, { sort: 'promise', maxLen: '600' });
});

check('a valid session round-trips', () => {
  put({
    view: { center: [-4.36, 56.79], zoom: 12.5 },
    filters: { minGrad: '12', maxGrad: '100', minLen: '200', maxLen: '600',
               minDrain: '4', maxDrain: '200', minConf: '0', minAlt: '0',
               sort: 'promise', viewOnly: 'false', hideLogged: 'true',
               showKnown: 'true', basemap: 'sat' },
    selected: { kind: 'reach', id: '1234:56' },
  });
  assert.deepEqual(loadState(), {
    view: { center: [-4.36, 56.79], zoom: 12.5 },
    filters: { minGrad: '12', maxGrad: '100', minLen: '200', maxLen: '600',
               minDrain: '4', maxDrain: '200', minConf: '0', minAlt: '0',
               sort: 'promise', viewOnly: 'false', hideLogged: 'true',
               showKnown: 'true', basemap: 'sat' },
    selected: { kind: 'reach', id: '1234:56' },
  });
});

check('saves merge over what is stored, and null clears the selection', () => {
  store.clear();
  saveState({ filters: { sort: 'drop' } });
  saveState({ view: { center: [-5, 57], zoom: 7 } });
  saveState({ selected: { kind: 'group', id: '9:Some Burn' } });
  let s = loadState();
  assert.equal(s.filters?.sort, 'drop');
  assert.equal(s.view?.zoom, 7);
  assert.deepEqual(s.selected, { kind: 'group', id: '9:Some Burn' });

  saveState({ selected: null }); // the detail card was closed
  s = loadState();
  assert.equal(s.selected, null);
  assert.equal(s.filters?.sort, 'drop'); // the rest survived
  assert.equal(s.view?.zoom, 7);
});

check('a save that throws (quota, private mode) is swallowed', () => {
  store.clear();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: () => null,
    setItem: () => { throw new Error('QuotaExceededError'); },
  };
  assert.doesNotThrow(() => saveState({ view: { center: [-4.6, 56.9], zoom: 6 } }));
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
  };
});

const calibrated = { minGrad: '12', maxGrad: '100', minLen: '200', maxLen: '600',
                     minDrain: '4', maxDrain: '200', minConf: '0', minAlt: '0',
                     sort: 'promise' };

check('preset matching recognises a measured slider set', () => {
  assert.equal(presetFor(calibrated), 'calibrated');
  // The panel saves more than the preset sets; the extras must not break it.
  assert.equal(presetFor({ ...calibrated, viewOnly: 'true', basemap: 'sat' }), 'calibrated');
});

check('preset matching is exact — one moved slider means custom', () => {
  assert.equal(presetFor(undefined), null);
  assert.equal(presetFor({ ...calibrated, minGrad: '15' }), null);
  assert.equal(presetFor({ ...calibrated, sort: 'drop' }), null);
  assert.equal(presetFor({ ...calibrated, maxLen: '600.5' }), null);
  assert.equal(presetFor({}), null);
});

check('every preset matches itself', () => {
  // The strings must be the slider values, not numbers: the panel saves strings.
  for (const [name, values] of Object.entries(PRESETS)) {
    const filters = Object.fromEntries(Object.entries(values).map(([id, v]) => [id, String(v)]));
    assert.equal(presetFor(filters), name, `${name} does not match its own values`);
  }
});

console.log(failures ? `\n${failures} test(s) failed` : '\nall tests passed');
process.exit(failures ? 1 : 0);
