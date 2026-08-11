/**
 * Slider sets worth starting from. The numbers come from canyon.analyse: the
 * graded-canyon medians and the filter table, not taste.
 */
export const PRESETS: Record<string, Record<string, number | string>> = {
  // grad >= 12% & catchment >= 3 km keeps 45% of graded canyons at 13 candidates each.
  calibrated: { minGrad: 12, maxGrad: 100, minLen: 200, maxLen: 600,
                minCatch: 3, maxCatch: 100, minConf: 0, minAlt: 0, sort: 'promise' },
  // The 95%-recall setting: nearly every logged canyon survives this.
  wide: { minGrad: 8, maxGrad: 100, minLen: 200, maxLen: 2000,
          minCatch: 1, maxCatch: 100, minConf: 0, minAlt: 0, sort: 'promise' },
  // Catchment is the strongest single discriminator; lean on it.
  bigwater: { minGrad: 10, maxGrad: 100, minLen: 200, maxLen: 1200,
              minCatch: 8, maxCatch: 100, minConf: 0, minAlt: 0, sort: 'promise' },
  gorge: { minGrad: 12, maxGrad: 100, minLen: 200, maxLen: 800,
           minCatch: 2, maxCatch: 100, minConf: 20, minAlt: 0, sort: 'confine' },
  falls: { minGrad: 20, maxGrad: 100, minLen: 100, maxLen: 300,
           minCatch: 2, maxCatch: 100, minConf: 0, minAlt: 0, sort: 'steepest' },
  // Steep burns too small to clear the catchment floors above. The promise model
  // underrates these (upstream channel length reads near zero on a headwater), so
  // rank them by drop instead.
  small: { minGrad: 15, maxGrad: 100, minLen: 150, maxLen: 800,
           minCatch: 0.5, maxCatch: 6, minConf: 0, minAlt: 0, sort: 'drop' },
  long: { minGrad: 8, maxGrad: 100, minLen: 1000, maxLen: 5000,
          minCatch: 3, maxCatch: 100, minConf: 0, minAlt: 0, sort: 'length' },
};

