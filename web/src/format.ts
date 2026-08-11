/**
 * The lines the detail card shows. Pure string building, kept out of main.ts so
 * the numbers can be tested — an undefined here renders as "NaN" to the user.
 */
import type { Group } from './grouping.ts';
import type { Candidate } from './types.ts';

export interface Context {
  /** 0-1 against the logged canyons, or null when no model is loaded. */
  promise: number | null;
  /** Whether a Canyon Log entry sits on this water. */
  logged: boolean;
}

/** The watercourse summary — the context a single reach sits in. */
export function watercourseLine(group: Group, ctx: Context): string {
  const n = group.members.length;
  const p = ctx.promise === null
    ? ''
    : `<span class="promise">promise ${(ctx.promise * 100).toFixed(0)}</span> · `;
  const logged = ctx.logged ? '<span class="tag mini">logged</span> · ' : '';
  if (n === 1) {
    const only = group.members[0];
    return `${p}${logged}one reach · ${only.catchment.toFixed(1)} km upstream · ` +
      `${only.dem} DEM`;
  }
  return `${p}${logged}${n} reaches · ${group.steepDrop.toFixed(0)} m of drop in ` +
    `${(group.steepLength / 1000).toFixed(2)} km of steep channel · ` +
    `${group.spanDrop.toFixed(0)} m over a ${(group.spanLength / 1000).toFixed(2)} km span ` +
    `(${(group.spanDrop / group.spanLength * 100).toFixed(0)}% overall) · ` +
    `best ${(group.best.gradient * 100).toFixed(0)}% · ` +
    `${group.features.catchment_km.toFixed(1)} km upstream`;
}

export function reachLine(c: Candidate): string {
  return `${(c.gradient * 100).toFixed(1)}% over ${c.length.toFixed(0)} m · ` +
    `${c.drop.toFixed(0)} m drop · steepest 100 m ${(c.steepest * 100).toFixed(0)}% · ` +
    `${c.top.toFixed(0)}→${c.bottom.toFixed(0)} m · ${c.catchment.toFixed(1)} km upstream · ` +
    `confinement ${c.confine.toFixed(0)} m · ${c.dem} DEM`;
}

