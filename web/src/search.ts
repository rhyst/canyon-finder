import type { Candidate, ChainMeta, Payload, Query, ScoreModel } from './types.ts';

let meta: Payload;
let model: ScoreModel | null = null;
let z: Int16Array; // decimetres
let up: Uint16Array; // 0.1 km of upstream watercourse
let drain: Float32Array; // km² draining to the sample, from canyon.watershed
let conf: Uint8Array; // metres of valley-side rise 100 m out
let lon: Float64Array;
let lat: Float64Array;
let bounds: Float64Array; // per chain: minLon, minLat, maxLon, maxLat

// Drainage area is stored as a delta of sqrt(km²) in fixed point; two bytes
// cannot hold 5,000 km² linearly and still resolve a headwater burn. Must match
// DRAIN_SCALE in canyon/payload.py.
const DRAIN_SCALE = 500;

export function decode(bin: ArrayBuffer, payload: Payload, score?: ScoreModel | null) {
  meta = payload;
  model = score ?? null;
  const head = new DataView(bin);
  const magic = String.fromCharCode(...new Uint8Array(bin, 0, 4));
  if (magic !== 'CNY4') throw new Error(`bad payload magic: ${magic}`);
  const total = head.getUint32(4, true);
  let off = 16;
  z = new Int16Array(bin, off, total);
  off += total * 2;
  up = new Uint16Array(bin, off, total);
  off += total * 2;
  const dlon = new Int16Array(bin, off, total);
  const dlat = new Int16Array(bin, off + total * 2, total);
  const ddrain = new Uint16Array(bin, off + total * 4, total);
  conf = new Uint8Array(bin, off + total * 6, total);

  lon = new Float64Array(total);
  lat = new Float64Array(total);
  drain = new Float32Array(total);
  bounds = new Float64Array(payload.chains.length * 4);
  payload.chains.forEach((c, ci) => {
    let qlon = c.lon0;
    let qlat = c.lat0;
    let qdrain = c.drain0 ?? 0;
    let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
    for (let k = 0; k < c.n; k++) {
      if (k > 0) {
        qlon += dlon[c.o + k];
        qlat += dlat[c.o + k];
        qdrain += ddrain[c.o + k];
      }
      drain[c.o + k] = (qdrain / DRAIN_SCALE) ** 2;
      const a = qlon / 1e7;
      const b = qlat / 1e7;
      lon[c.o + k] = a;
      lat[c.o + k] = b;
      if (a < minLon) minLon = a;
      if (a > maxLon) maxLon = a;
      if (b < minLat) minLat = b;
      if (b > maxLat) maxLat = b;
    }
    bounds.set([minLon, minLat, maxLon, maxLat], ci * 4);
  });
}

/** Cheap reject: no window short enough to fit the query is anywhere near steep enough. */
function prescreen(c: ChainMeta, q: Query): boolean {
  let best = 0;
  meta.scales.forEach((s, k) => {
    if (s <= q.maxLength && c.screen[k] > best) best = c.screen[k];
  });
  if (meta.scales[0] > q.maxLength) best = Math.max(best, c.screen[0]);
  // A reach of gradient g contains a shorter window of at least g/2, so this
  // keeps everything the exact scan could accept.
  return best >= q.minGradient * 0.5;
}

/** Prospect score from the fitted model; 0 when no model is loaded.
 *
 * Feature order, caps and the log transform all come from score.json, so the
 * browser cannot drift from what canyon.analyse fitted.
 */
function prospect(raw: Record<string, number>): number {
  const m = model;
  if (!m) return 0;
  let s = m.weights[0];
  m.transform.forEach((t, k) => {
    let v = Math.max(raw[t.name] ?? 0, 0);
    if (t.cap !== undefined) v = Math.min(v, t.cap);
    if (t.log1p) v = Math.log1p(v);
    s += m.weights[k + 1] * ((v - m.mean[k]) / m.sd[k]);
  });
  return s;
}

function nameAt(c: ChainMeta, i: number): string {
  let name = c.name;
  for (const [start, n] of c.runs) {
    if (start > i) break;
    if (n) name = n;
  }
  return name;
}

/** Prefix sums of confinement, so a window mean costs O(1) inside the scan. */
let confSum = new Float64Array(0);

function prepareChain(o: number, n: number): void {
  if (confSum.length < n + 1) confSum = new Float64Array(n + 1);
  confSum[0] = 0;
  for (let k = 0; k < n; k++) confSum[k + 1] = confSum[k] + conf[o + k];
}

function windowConfine(i: number, j: number): number {
  return (confSum[j + 1] - confSum[i]) / (j - i + 1);
}

/** Steepest qualifying window in [from, to], grown out over its shoulders. */
function bestWindow(o: number, from: number, to: number, q: Query,
                    minK: number, maxK: number, sp: number): [number, number] | null {
  const gradient = (i: number, j: number) =>
    (z[o + i] - z[o + j]) / ((j - i) * sp * 10);
  const startOk = (i: number) =>
    drain[o + i] >= q.minDrain && up[o + i] / 10 >= q.minCatchment
    && z[o + i] / 10 >= q.minAltitude;
  // Both measures of water only grow downstream, so testing the foot of a window
  // bounds the whole of it.
  const smallEnough = (j: number) =>
    drain[o + j] <= q.maxDrain && up[o + j] / 10 <= q.maxCatchment;

  let peak = -1;
  let pi = -1;
  let pk = -1;
  for (let i = from; i + minK <= to; i++) {
    if (!startOk(i)) continue;
    const kEnd = Math.min(maxK, to - i);
    for (let k = minK; k <= kEnd; k++) {
      const g = gradient(i, i + k);
      if (g < q.minGradient) break; // longer only dilutes; a steeper section
      if (g > q.maxGradient) continue; // downstream is found from its own start
      if (!smallEnough(i + k)) break; // and only gets bigger further down
      if (q.minConfine > 0 && windowConfine(i, i + k) < q.minConfine) continue;
      if (g > peak) {
        peak = g;
        pi = i;
        pk = k;
      }
    }
  }
  if (peak < 0) return null;

  // Grow outwards while the reach keeps most of that steepness, so one steep
  // zone yields one reach instead of a row of minLength slices. Every filter is
  // re-checked, since growing upstream moves the start onto a new sample.
  const floor = Math.max(q.minGradient, peak * SHOULDER);
  let i = pi;
  let j = pi + pk;
  for (;;) {
    let grew = false;
    if (j - i < maxK && j < to && gradient(i, j + 1) >= floor && smallEnough(j + 1)
        && (q.minConfine === 0 || windowConfine(i, j + 1) >= q.minConfine)) {
      j++;
      grew = true;
    }
    if (j - i < maxK && i > from && startOk(i - 1) && gradient(i - 1, j) >= floor
        && (q.minConfine === 0 || windowConfine(i - 1, j) >= q.minConfine)) {
      i--;
      grew = true;
    }
    if (!grew) break;
  }
  return [i, j];
}

// A reach grows outwards from its steepest window while it holds this share of
// that peak gradient.
const SHOULDER = 0.8;

// A long chain can hold many qualifying reaches; this bounds the recursion.
const MAX_REACHES_PER_CHAIN = 24;

/**
 * Backstop only, not a display cap: a 2% gradient query over all of Scotland
 * finds ~205k reaches in 1.4 s, and nothing realistic comes close. Hitting this
 * is reported to the UI, never silent.
 */
const MAX_REACHES = 400_000;

export function search(q: Query): {
  candidates: Candidate[];
  scanned: number;
  truncated: boolean;
} {
  const sp = meta.spacing;
  const minK = Math.max(1, Math.round(q.minLength / sp));
  const maxK = Math.max(minK, Math.round(q.maxLength / sp));
  const sub = Math.max(1, Math.round(100 / sp)); // 100m window for the steepness flag
  const out: Candidate[] = [];
  let scanned = 0;

  for (let ci = 0; ci < meta.chains.length; ci++) {
    const c = meta.chains[ci];
    if (!prescreen(c, q)) continue;
    scanned++;
    const o = c.o;
    prepareChain(o, c.n);

    // Steepest window first, then recurse either side of it. Scanning
    // left-to-right instead would let a long shallow reach swallow the steep
    // core inside it and, because reaches cannot overlap, hide it completely.
    const ranges: [number, number][] = [[0, c.n - 1]];
    let emitted = 0;
    while (ranges.length && emitted < MAX_REACHES_PER_CHAIN) {
      const [from, to] = ranges.pop()!;
      if (to - from < minK) continue;
      const found = bestWindow(o, from, to, q, minK, maxK, sp);
      if (!found) continue;
      const [i, j] = found;
      emitted++;

      const length = (j - i) * sp;
      const drop = (z[o + i] - z[o + j]) / 10;
      let steepest = 0;
      for (let t = i; t + sub <= j; t++) {
        const g = (z[o + t] - z[o + t + sub]) / (sub * sp * 10);
        if (g > steepest) steepest = g;
      }
      const catchment = up[o + i] / 10;
      const area = drain[o + i];
      const confine = windowConfine(i, j);
      out.push({
        chain: ci,
        i,
        j,
        name: nameAt(c, i) || 'Unnamed burn',
        length,
        drop,
        gradient: drop / length,
        steepest: steepest || drop / length,
        catchment,
        drain: area,
        confine,
        score: prospect({
          gradient: drop / length,
          catchment_km: catchment,
          drain_km2: area,
          confine_100m: confine,
        }),
        top: z[o + i] / 10,
        bottom: z[o + j] / 10,
        dem: c.dem ?? '50 m',
        lon: lon[o + i],
        lat: lat[o + i],
        // Geometry is filled in later, for the reaches that survive the cap:
        // building it for every match costs more than the search itself.
        coords: [],
      });
      ranges.push([from, i], [j, to]);
    }
    if (out.length >= MAX_REACHES) {
      return { candidates: out, scanned, truncated: true };
    }
  }
  return { candidates: out, scanned, truncated: false };
}

/** Attach the polyline for a reach. Called only for what gets displayed. */
export function fillCoords(c: Candidate): Candidate {
  if (c.coords.length) return c;
  const o = meta.chains[c.chain].o;
  const coords: [number, number][] = [];
  for (let t = c.i; t <= c.j; t++) coords.push([lon[o + t], lat[o + t]]);
  c.coords = coords;
  return c;
}

export function profile(chain: number, i: number, j: number) {
  const c = meta.chains[chain];
  const pad = Math.round(300 / meta.spacing);
  const from = Math.max(0, i - pad);
  const to = Math.min(c.n - 1, j + pad);
  const pts: { d: number; z: number; inside: boolean }[] = [];
  for (let s = from; s <= to; s++) {
    pts.push({ d: (s - i) * meta.spacing, z: z[c.o + s] / 10, inside: s >= i && s <= j });
  }
  return pts;
}

