export interface ChainMeta {
  o: number;
  n: number;
  name: string;
  runs: [number, string][];
  /** Inclusive sample runs within the mapped dam buffer. */
  dams?: [number, number][];
  screen: number[];
  /** Steep sections as inclusive sample ranges; see canyon/sections.py. */
  sections?: [number, number][];
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
  | 'score' | 'drop' | 'gradient' | 'steepest' | 'length' | 'drain' | 'confine';

/** Logistic fit of sections holding a rated canyon vs the rest, from canyon.rank. */
export interface ScoreModel {
  /** Payload the fit was made against; see canyon/payload.py. */
  index_id?: string;
  /** Feature names are Candidate fields. */
  transform: { name: string; cap?: number; log1p?: boolean }[];
  mean: number[];
  sd: number[];
  weights: number[];
  /** [top share of sections, share of rated canyons it holds], out of fold. */
  capture: [number, number][];
  /** A badge shows when a section reaches the rated canyons' median. */
  badges: {
    gradient: number; drop: number; confine: number; drops: number;
    /** Drainage area range, km², holding the middle 80% of rated canyons. */
    water: [number, number];
  };
  auc_out_of_fold: number;
  auc_other_region: number;
  fitted_on: { positive: number; background: number };
}

export interface Query {
  sort: SortKey;
  minGradient: number;
  maxGradient: number;
  minLength: number;
  maxLength: number;
  /** Drainage area floor at the top of the section, in km². */
  minDrain: number;
  /** Drainage area ceiling at its foot, in km². Infinity for no limit. */
  maxDrain: number;
  minConfine: number;
  minAltitude: number;
  /** Total drop floor, in metres. 0 for no limit. */
  minDrop: number;
  /** Keep only sections ranked in this top share of Great Britain; 1 for all. */
  topShare?: number;
}

export interface Candidate {
  chain: number;
  i: number;
  j: number;
  name: string;
  length: number;
  drop: number;
  gradient: number;
  steepest: number; // steepest 100m within the section
  catchment: number; // km of watercourse upstream of the top
  drain: number; // km² draining to the top of the section
  drainFoot: number; // and to its foot
  confine: number; // mean rise of the lower valley side 100 m out, metres
  confineMax: number;
  power: number; // gradient x drainage^0.45
  dam?: boolean; // overlaps a mapped dam or its immediate spillway
  score: number; // raw model score; higher is more canyon-like
  rank: number; // share of all sections scoring at least this well, 0-1
  place: number; // 1 is the best section in Great Britain
  drops: number; // distinct falls of FALL_DROP m or more
  single: number; // share of the drop inside the steepest 100 m, 0-1
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
  /** Canyon Log's quality rating, 0–4; null where nobody has graded it. */
  stars?: number | null;
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
  source?: 'canyon-log' | 'visit';
}
