export interface ChainMeta {
  o: number;
  n: number;
  name: string;
  runs: [number, string][];
  /** Inclusive sample runs within the mapped dam buffer. */
  dams?: [number, number][];
  screen: number[];
  drain0?: number;
  top: number;
  bottom: number;
  dem?: string;
  lon0: number;
  lat0: number;
}

export interface Payload {
  /** Fingerprint of the chain index; see canyon/payload.py. */
  index_id?: string;
  spacing: number;
  scales: number[];
  confine_radius?: number;
  samples: number;
  dem: string;
  chains: ChainMeta[];
}

export type SortKey =
  | 'promise' | 'score' | 'drop' | 'gradient' | 'steepest' | 'length'
  | 'drain' | 'confine';

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
  /** Drainage area floor, in km². This is what the UI exposes. */
  minDrain: number;
  /** Drainage area ceiling, in km². Infinity for no limit. */
  maxDrain: number;
  /** Upstream channel length bounds, in km. Kept so the two ways of measuring
   * how much water a reach carries stay comparable — see tools/thresholds.ts. */
  minCatchment: number;
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
  dam?: boolean; // overlaps a mapped dam or its immediate spillway
  score: number; // prospect score; higher ranks more canyon-like
  top: number;
  bottom: number;
  dem: string;
  lon: number;
  lat: number;
  coords: [number, number][];
}

/** A community visit report, from a data/visits/ pull request.
 * See docs/feature-visits.md for the data flow. */
export interface VisitReport {
  author: string;
  date: string; // YYYY-MM-DD
  /** 0 = not worth it, 1-4 = worth it (Canyon Log's vocabulary). */
  stars: number;
  name?: string;
  description?: string;
  grade?: string;
  pitches?: number;
  highestPitchM?: number;
  /** The reporter's measured values. Display-only: search and fit use the
   * pipeline's measurements. */
  corrections?: { drop_m?: number; length_m?: number };
  images?: { file: string; caption?: string; url: string }[];
  links?: string[];
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
  /** Community visit reports: attached to a logged entry, or its own entry. */
  visits?: VisitReport[];
  /** Set on entries created by the visit stage rather than the Canyon Log stage. */
  source?: string;
}
