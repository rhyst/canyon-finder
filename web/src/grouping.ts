/**
 * Grouping model for the results list: one group per named watercourse on a
 * chain, flattened into the rows the list actually shows. Kept free of DOM and
 * map code so it can be tested directly.
 */
import type { Candidate } from './types.ts';

export interface Group {
  key: string;
  name: string;
  chain: number;
  members: Candidate[]; // in downstream order
  best: Candidate; // by the current sort
  spanLength: number; // first reach top to last reach bottom
  spanDrop: number;
  steepLength: number; // channel actually inside a qualifying reach
  steepDrop: number;
  features: GroupFeatures;
}

/**
 * What a whole watercourse looks like, as opposed to one reach. These are the
 * inputs to the group-level ranking fitted by canyon.rank.
 */
export interface GroupFeatures {
  peak_gradient: number; // steepest reach on it
  overall_gradient: number; // span drop / span length
  steep_drop: number; // metres of descent inside qualifying reaches
  steep_length: number;
  span_length: number;
  continuity: number; // steep_length / span_length: one gorge or scattered steps
  reaches: number;
  catchment_km: number; // at the foot, where the water is greatest
  drain_km2: number; // drainage area at the foot, the same idea measured properly
  confine_max: number;
  confine_median: number;
  top_m: number;
}

function median(xs: number[]): number {
  const v = [...xs].sort((a, b) => a - b);
  const h = v.length / 2;
  return v.length % 2 ? v[Math.floor(h)] : (v[h - 1] + v[h]) / 2;
}

export function groupFeatures(members: Candidate[], spacing: number): GroupFeatures {
  const first = members[0];
  const last = members[members.length - 1];
  const spanLength = (last.j - first.i) * spacing;
  const spanDrop = first.top - last.bottom;
  const steepLength = members.reduce((t, c) => t + c.length, 0);
  return {
    peak_gradient: Math.max(...members.map((c) => c.gradient)),
    overall_gradient: spanLength ? spanDrop / spanLength : 0,
    steep_drop: members.reduce((t, c) => t + c.drop, 0),
    steep_length: steepLength,
    span_length: spanLength,
    continuity: spanLength ? steepLength / spanLength : 1,
    reaches: members.length,
    catchment_km: Math.max(...members.map((c) => c.catchment)),
    drain_km2: Math.max(...members.map((c) => c.drain)),
    confine_max: Math.max(...members.map((c) => c.confine)),
    confine_median: median(members.map((c) => c.confine)),
    top_m: first.top,
  };
}

export type Row = { group: Group; cand: Candidate | null };

export function groupOf(c: Candidate) {
  return `${c.chain}:${c.name}`;
}

export function candId(c: Candidate) {
  return `${c.chain}:${c.i}`;
}

/** One group per named watercourse on a chain, ordered by its best member. */
export function buildGroups(
  list: Candidate[],
  key: keyof Candidate | 'promise',
  spacing: number,
  model: GroupModel | null = null,
): Group[] {
  const memberKey = (key === 'promise' ? 'score' : key) as keyof Candidate;
  const byKey = new Map<string, Candidate[]>();
  for (const c of list) {
    const k = groupOf(c);
    byKey.set(k, [...(byKey.get(k) ?? []), c]);
  }
  const groups = [...byKey.entries()].map(([k, members]) => {
    members.sort((a, b) => a.i - b.i);
    const first = members[0];
    const last = members[members.length - 1];
    return {
      key: k,
      name: first.name,
      chain: first.chain,
      members,
      best: members.reduce((m, c) =>
        ((c[memberKey] as number) > (m[memberKey] as number) ? c : m)),
      spanLength: (last.j - first.i) * spacing,
      spanDrop: first.top - last.bottom,
      steepLength: members.reduce((t, c) => t + c.length, 0),
      steepDrop: members.reduce((t, c) => t + c.drop, 0),
      features: groupFeatures(members, spacing),
    };
  });
  if (key === 'promise') {
    groups.sort((a, b) => groupScore(b, model) - groupScore(a, model));
  } else {
    groups.sort((a, b) => (b.best[memberKey] as number) - (a.best[memberKey] as number));
  }
  return groups;
}


/** Flatten groups into list rows, expanding the given keys. */
export function buildRows(groups: Group[], expanded: Set<string>): Row[] {
  const rows: Row[] = [];
  for (const g of groups) {
    rows.push({ group: g, cand: null });
    if (expanded.has(g.key) && g.members.length > 1) {
      for (const c of g.members) rows.push({ group: g, cand: c });
    }
  }
  return rows;
}

/** Row showing a candidate, or its group header when the group is collapsed. */
export function findRow(rows: Row[], id: string): number {
  const at = rows.findIndex((r) => r.cand && candId(r.cand) === id);
  if (at >= 0) return at;
  return rows.findIndex((r) => !r.cand && r.group.members.some((c) => candId(c) === id));
}

/**
 * How canyon-like a whole watercourse is, as a fraction of the way through the
 * logged canyons: 0.5 means "as canyon-like as the median logged descent".
 *
 * The underlying fit is a probability, but at a 0.7% base rate a calibrated
 * probability reads as 1% for a perfectly good canyon, which is useless to look
 * at. Ranking is identical either way — this is a monotone rescaling.
 */
export function groupScore(g: Group, model: GroupModel | null): number {
  if (!model) return 0;
  const raw = groupLogOdds(g, model);
  const q = model.graded_scores;
  if (!q?.length) return 1 / (1 + Math.exp(-raw));
  if (raw <= q[0]) return 0;
  if (raw >= q[q.length - 1]) return 1;
  let hi = 0;
  while (hi < q.length && q[hi] < raw) hi++;
  const span = q[hi] - q[hi - 1] || 1;
  return (hi - 1 + (raw - q[hi - 1]) / span) / (q.length - 1);
}

function groupLogOdds(g: Group, model: GroupModel): number {
  let s = model.weights[0];
  model.transform.forEach((t, k) => {
    let v = g.features[t.name as keyof GroupFeatures] ?? 0;
    if (t.cap !== undefined) v = Math.min(v, t.cap);
    if (t.log1p) v = Math.log1p(Math.max(v, 0));
    s += model.weights[k + 1] * ((v - model.mean[k]) / model.sd[k]);
  });
  return s;
}

export interface GroupModel {
  /** Payload the fit was made against; see canyon/payload.py. */
  index_id?: string;
  transform: { name: string; cap?: number; log1p?: boolean }[];
  mean: number[];
  sd: number[];
  weights: number[];
  query: Record<string, number>;
  graded_scores?: number[]; // fitted scores of the logged canyons, ascending
  auc_vs_background: number;
  auc_vs_zero_star: number;
  fitted_on: { positive: number; background: number };
}

/** Metres from a group to the nearest logged entry, capped for display. */
export function nearestLogged(
  g: Group,
  logged: { lon: number; lat: number }[],
): number {
  const p = g.members[Math.floor(g.members.length / 2)];
  let best = Infinity;
  for (const k of logged) {
    const dx = (k.lon - p.lon) * Math.cos((p.lat * Math.PI) / 180) * 111_320;
    const dy = (k.lat - p.lat) * 110_540;
    const d = Math.hypot(dx, dy);
    if (d < best) best = d;
  }
  return best;
}

/** The logged canyons sitting on this group's water: an entry counts when its
 *  window overlaps a member reach on the same chain — the same rule `covered`
 *  uses for the status count, so the tag and the count cannot disagree.
 *
 *  A point distance cannot do this job. The logged marker sits at the top of
 *  its window, the group's nearest sample is wherever its middle reach happens
 *  to start, and the gap between those two points is not the gap to the water:
 *  Dollar Canyon overlaps its reach directly and still measured 254 m. */
export function loggedOn<T extends { chain: number; i: number; j: number }>(
  g: Group,
  logged: T[],
): T[] {
  return logged.filter((k) =>
    k.chain === g.chain && g.members.some((m) => m.i <= k.j && m.j >= k.i));
}
