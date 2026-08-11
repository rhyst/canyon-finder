/** Canyon Log's grading vocabulary, as it appears in `known.json`. */
import type { Candidate, KnownCanyon } from './types.ts';

/** Grades that mean someone descended it and rated it worth doing. */
export const GRADED = ['Basic', 'Moderate', 'Advanced'];

/** Visited and reported as not worth the walk — the search's true negatives. */
export const ZERO_STAR = '0 Stars';

export function isDud(k: KnownCanyon): boolean {
  return k.category === ZERO_STAR;
}

export function isGraded(k: KnownCanyon): boolean {
  return GRADED.includes(k.category);
}

/**
 * Which logged canyons the current results actually reach — a reach on the same
 * chain overlapping the logged one.
 *
 * Comparing each canyon's stored gradient and length against the sliders instead
 * looks equivalent and is not: it ignores every other filter, so the count sat
 * still while catchment or confinement threw canyons away.
 */
export function covered(logged: KnownCanyon[], candidates: Candidate[]): KnownCanyon[] {
  const byChain = new Map<number, Candidate[]>();
  for (const c of candidates) {
    const list = byChain.get(c.chain);
    if (list) list.push(c);
    else byChain.set(c.chain, [c]);
  }
  return logged.filter((k) =>
    (byChain.get(k.chain) ?? []).some((c) => c.i <= k.j && c.j >= k.i));
}
