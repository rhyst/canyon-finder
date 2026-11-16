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
  buildSections();
}

/** Section score from the fitted model; 0 when no model is loaded.
 *
 * Feature names, caps and the log transform all come from score.json, so the
 * browser cannot drift from what canyon.rank fitted.
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

/** Every section in the payload, measured and scored once at load. A section
 *  is fixed water, so a query only filters this list. */
let sections: Candidate[] = [];

// A fall is a run of samples at this gradient or more, dropping this far.
const FALL_GRADIENT = 0.2;
const FALL_DROP = 8;

function measure(ci: number, i: number, j: number): Candidate {
  const c = meta.chains[ci];
  const o = c.o;
  const sp = meta.spacing;
  const sub = Math.max(1, Math.round(100 / sp));
  const length = (j - i) * sp;
  const drop = (z[o + i] - z[o + j]) / 10;
  const gradient = drop / length;
  // A section shorter than the window drops its whole fall inside it.
  let steepest = length < sub * sp ? drop / (sub * sp) : 0;
  for (let t = i; t + sub <= j; t++) {
    const g = (z[o + t] - z[o + t + sub]) / (sub * sp * 10);
    if (g > steepest) steepest = g;
  }
  let drops = 0;
  let run = 0;
  for (let t = i; t <= j; t++) {
    const d = t < j ? (z[o + t] - z[o + t + 1]) / 10 : 0;
    if (d / sp >= FALL_GRADIENT) run += d;
    else {
      if (run >= FALL_DROP) drops++;
      run = 0;
    }
  }
  let confSum = 0;
  let confineMax = 0;
  for (let t = i; t <= j; t++) {
    confSum += conf[o + t];
    if (conf[o + t] > confineMax) confineMax = conf[o + t];
  }
  const cand: Candidate = {
    chain: ci,
    i,
    j,
    name: nameAt(c, i) || 'Unnamed burn',
    length,
    drop,
    gradient,
    steepest,
    drops,
    single: Math.min(1, (steepest * 100) / Math.max(drop, 1e-9)),
    catchment: up[o + i] / 10,
    drain: drain[o + i],
    drainFoot: drain[o + j],
    confine: confSum / (j - i + 1),
    confineMax,
    // Gradient corrected for the water carrying it: a steep trickle and a
    // gentle river both score low.
    power: gradient * drain[o + i] ** 0.45,
    dam: c.dams?.some(([from, to]) => i <= to && j >= from) ?? false,
    score: 0,
    rank: 1,
    place: 0,
    top: z[o + i] / 10,
    bottom: z[o + j] / 10,
    dem: c.dem ?? '50 m',
    lon: lon[o + i],
    lat: lat[o + i],
    coords: [],
  };
  cand.score = prospect(cand as unknown as Record<string, number>);
  return cand;
}

function buildSections() {
  sections = [];
  meta.chains.forEach((c, ci) => {
    for (const [i, j] of c.sections ?? []) sections.push(measure(ci, i, j));
  });
  // Rank is against every section in Great Britain, so it does not move with
  // the filters.
  const order = [...sections].sort((a, b) => b.score - a.score);
  order.forEach((c, k) => { c.place = k + 1; c.rank = c.place / order.length; });
}

export function search(q: Query): {
  candidates: Candidate[];
  scanned: number;
  truncated: boolean;
} {
  const candidates = sections.filter((c) =>
    c.gradient >= q.minGradient && c.gradient <= q.maxGradient
    && c.length >= q.minLength && c.length <= q.maxLength
    && c.drop >= (q.minDrop ?? 0)
    && c.drain >= q.minDrain && c.drainFoot <= q.maxDrain
    && c.confine >= q.minConfine && c.top >= q.minAltitude
    && c.rank <= (q.topShare ?? 1));
  return { candidates, scanned: sections.length, truncated: false };
}

/** Attach the polyline for a section. */
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
  const pts: { d: number; z: number; inside: boolean; lon: number; lat: number }[] = [];
  for (let s = from; s <= to; s++) {
    pts.push({
      d: (s - i) * meta.spacing, z: z[c.o + s] / 10, inside: s >= i && s <= j,
      lon: lon[c.o + s], lat: lat[c.o + s],
    });
  }
  return pts;
}

