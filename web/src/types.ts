export interface ChainMeta {
  o: number;
  n: number;
  name: string;
  runs: [number, string][];
  screen: number[];
  drain0?: number;
  top: number;
  bottom: number;
  dem?: string;
  lon0: number;
  lat0: number;
}

export interface Payload {
  spacing: number;
  scales: number[];
  confine_radius?: number;
  samples: number;
  dem: string;
  chains: ChainMeta[];
}

export type SortKey =
  | 'promise' | 'score' | 'drop' | 'gradient' | 'steepest' | 'length'
  | 'catchment' | 'confine';

/** Logistic fit of graded canyons vs background, from canyon.analyse. */
export interface ScoreModel {
  transform: { name: string; cap?: number; log1p?: boolean }[];
  mean: number[];
  sd: number[];
  weights: number[];
  auc_vs_background: number;
  auc_vs_zero_star: number;
  fitted_on: { graded: number; background: number };
}

export interface Query {
  sort: SortKey;
  minGradient: number;
  maxGradient: number;
  minLength: number;
  maxLength: number;
  minCatchment: number;
  /** Upstream channel length ceiling, in km. Infinity for no limit. */
  maxCatchment: number;
  minConfine: number;
  minAltitude: number;
}

export interface Candidate {
  chain: number;
  i: number;
  j: number;
  name: string;
  length: number;
  drop: number;
  gradient: number;
  steepest: number; // steepest 100m within the reach
  catchment: number; // km of watercourse upstream of the top
  drain: number; // km² draining to the top of the reach
  confine: number; // mean rise of the lower valley side 100 m out, metres
  score: number; // prospect score; higher ranks more canyon-like
  top: number;
  bottom: number;
  dem: string;
  lon: number;
  lat: number;
  coords: [number, number][];
}

/** A community-logged descent from Canyon Log, snapped onto our profiles. */
export interface KnownCanyon {
  name: string;
  grade: string;
  category: string;
  url: string;
  note: string;
  watercourse: string;
  snap_m: number;
  chain: number;
  i: number;
  j: number;
  gradient: number;
  drop: number;
  length: number;
  dem: string;
  lon: number;
  lat: number;
  coords: [number, number][];
}
