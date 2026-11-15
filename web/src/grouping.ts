/**
 * Grouping model for the results list: the sections of one named watercourse
 * share a header row. Display only — a watercourse has no score of its own,
 * it carries its best section's. Kept free of DOM and map code so it can be
 * tested directly.
 */
import type { Candidate, SortKey } from './types.ts';

export interface Group {
  key: string;
  name: string;
  chain: number;
  members: Candidate[]; // in downstream order
  best: Candidate; // by the current sort
  drop: number; // summed over members
  length: number;
}

export type Row = { group: Group; cand: Candidate | null };

export function groupOf(c: Candidate) {
  return `${c.chain}:${c.name}`;
}

export function candId(c: Candidate) {
  return `${c.chain}:${c.i}`;
}

/** One group per named watercourse on a chain, ordered by its best member. */
export function buildGroups(list: Candidate[], key: SortKey): Group[] {
  const byKey = new Map<string, Candidate[]>();
  for (const c of list) {
    const k = groupOf(c);
    const members = byKey.get(k);
    if (members) members.push(c);
    else byKey.set(k, [c]);
  }
  const groups = [...byKey.entries()].map(([k, members]) => {
    members.sort((a, b) => a.i - b.i);
    return {
      key: k,
      name: members[0].name,
      chain: members[0].chain,
      members,
      best: members.reduce((m, c) => (c[key] > m[key] ? c : m)),
      drop: members.reduce((t, c) => t + c.drop, 0),
      length: members.reduce((t, c) => t + c.length, 0),
    };
  });
  return groups.sort((a, b) => b.best[key] - a.best[key]);
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

/** Metres from a group to the nearest logged entry. */
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

/** The logged canyons associated with this group's water: an entry counts when
 *  its window overlaps a member section, or the group starts within 500 m
 *  downstream on the same traced chain. The latter carries a visit across a
 *  nearby OS name boundary without claiming kilometres of downstream river.
 *
 *  A point distance cannot do this job. The logged marker sits at the top of
 *  its window, the group's nearest sample is wherever its middle section
 *  happens to start, and the gap between those two points is not the gap to
 *  the water. */
export function loggedOn<T extends { chain: number; i: number; j: number }>(
  g: Group,
  logged: T[],
  spacing: number,
): T[] {
  const first = Math.min(...g.members.map((m) => m.i));
  return logged.filter((k) => k.chain === g.chain && (
    g.members.some((m) => m.i <= k.j && m.j >= k.i)
    || (first > k.j && (first - k.j) * spacing <= 500)
  ));
}
