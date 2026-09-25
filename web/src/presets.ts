/**
 * Slider sets worth starting from. The numbers come from measurement, not taste:
 * `node --experimental-strip-types tools/thresholds.ts` sweeps every drainage
 * bound through the app's own search and reports what each one keeps and what it
 * throws away. Each floor below is the one that holds or improves the preset's
 * recall of logged descents while sifting no harder than the channel-length
 * bound it replaces.
 *
 * Every preset except the small-burn one defaults to a 50 m drop floor — a
 * starting point, not a recall-tuned bound. The small-burn preset keeps it at 0
 * so the shallow headwater burns stay in.
 */
export const PRESETS: Record<string, Record<string, number | string>> = {
  // grad >= 12% & >=50 m drop over 200–600 m: ~38% of graded canyons at 12 candidates each.
  calibrated: { minGrad: 12, maxGrad: 100, minLen: 200, maxLen: 600,
                minDrop: 50, minDrain: 4, maxDrain: 200, minConf: 0, minAlt: 0, sort: 'promise' },
  // The widest net: ~57% of graded canyons clear the 50 m drop floor here.
  wide: { minGrad: 8, maxGrad: 100, minLen: 200, maxLen: 2000,
          minDrop: 50, minDrain: 1, maxDrain: 200, minConf: 0, minAlt: 0, sort: 'promise' },
  // Drainage area is the strongest single discriminator; lean on it.
  bigwater: { minGrad: 10, maxGrad: 100, minLen: 200, maxLen: 1200,
              minDrop: 50, minDrain: 15, maxDrain: 200, minConf: 0, minAlt: 0, sort: 'promise' },
  gorge: { minGrad: 12, maxGrad: 100, minLen: 200, maxLen: 800,
           minDrop: 50, minDrain: 4, maxDrain: 200, minConf: 20, minAlt: 0, sort: 'confine' },
  falls: { minGrad: 20, maxGrad: 100, minLen: 100, maxLen: 300,
           minDrop: 50, minDrain: 3, maxDrain: 200, minConf: 0, minAlt: 0, sort: 'steepest' },
  // Steep burns too small to clear the floors above. The ceiling is what makes
  // this preset; it also keeps the drop floor at 0, so the shallow headwater
  // burns — including Allt Coire Sgamadail, which drains under 2 — stay in. The
  // promise model underrates these — little water is little water however it is
  // measured — so rank them by drop instead.
  small: { minGrad: 15, maxGrad: 100, minLen: 150, maxLen: 800,
           minDrop: 0, minDrain: 1, maxDrain: 12, minConf: 0, minAlt: 0, sort: 'drop' },
  long: { minGrad: 8, maxGrad: 100, minLen: 1000, maxLen: 5000,
          minDrop: 50, minDrain: 4, maxDrain: 200, minConf: 0, minAlt: 0, sort: 'length' },
};

