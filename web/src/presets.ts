import type { Query } from './types.ts';

/** No filter at all: every section in the payload. */
export const ALL: Query = {
  sort: 'score', minGradient: 0, maxGradient: Infinity, minLength: 0, maxLength: Infinity,
  minDrain: 0, maxDrain: Infinity, minConfine: 0, minAltitude: 0, minDrop: 0, topShare: 1,
};

/**
 * Filter sets worth starting from, keyed by input id. `tools/thresholds.ts`
 * reports what each one keeps of the rated canyons.
 */
const BASE = { minGrad: 5, maxGrad: 100, minLen: 50, maxLen: 5000, minDrop: 0,
               minDrain: 0, maxDrain: 200, minConf: 0, minAlt: 0, topShare: 100, sort: 'score' };

export const PRESETS: Record<string, Record<string, number | string>> = {
  calibrated: { ...BASE, topShare: 10 },
  wide: { ...BASE },
  promising: { ...BASE, topShare: 2 },
  bigwater: { ...BASE, minDrain: 15 },
  gorge: { ...BASE, minConf: 20, sort: 'confine' },
  falls: { ...BASE, minGrad: 20, maxLen: 500, sort: 'steepest' },
  // Steep burns the ranking underrates: little water is little water.
  small: { ...BASE, minGrad: 15, maxDrain: 5, sort: 'drop' },
  long: { ...BASE, minLen: 1000, sort: 'length' },
};

/** A preset as the query the app runs for it. The top of the length and
 *  drainage sliders means "no limit". */
export function presetQuery(p: Record<string, number | string>): Query {
  return {
    sort: p.sort as Query['sort'],
    minGradient: Number(p.minGrad) / 100,
    maxGradient: Number(p.maxGrad) / 100,
    minLength: Number(p.minLen),
    maxLength: Number(p.maxLen) >= 5000 ? Infinity : Number(p.maxLen),
    minDrain: Number(p.minDrain),
    maxDrain: Number(p.maxDrain) >= 200 ? Infinity : Number(p.maxDrain),
    minConfine: Number(p.minConf),
    minAltitude: Number(p.minAlt),
    minDrop: Number(p.minDrop),
    topShare: Number(p.topShare) / 100,
  };
}
