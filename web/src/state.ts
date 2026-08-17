/**
 * Session persistence: the last map view, the filter panel and the selected
 * watercourse, kept in localStorage so a reload lands back where you were.
 *
 * Kept free of DOM and map code so the validation can be tested directly. The
 * contents are ours but were written by whatever version of this file the
 * visitor last ran, so they are validated before being trusted — a corrupt or
 * foreign value is dropped, not thrown at the map.
 */
import { PRESETS } from './presets.ts';

const KEY = 'canyon-finder/v1';

/**
 * What was selected when the page went away, addressed the same way the data
 * is: a reach by (chain, i), a watercourse group by (chain, name), a logged
 * canyon by (chain, i, j) — the addressing known.json uses.
 */
export type SavedSelection =
  | { kind: 'reach'; id: string }
  | { kind: 'group'; id: string }
  | { kind: 'known'; id: string };

export interface SavedState {
  view?: { center: [number, number]; zoom: number };
  /** Element id -> input value; checkboxes as 'true'/'false'. */
  filters?: Record<string, string>;
  selected?: SavedSelection | null;
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function loadState(): SavedState {
  let doc: unknown;
  try {
    doc = JSON.parse(localStorage.getItem(KEY) ?? 'null');
  } catch {
    return {};
  }
  if (typeof doc !== 'object' || doc === null) return {};
  const out: SavedState = {};

  const view = (doc as Record<string, unknown>).view;
  if (typeof view === 'object' && view !== null) {
    const v = view as Record<string, unknown>;
    const c = v.center;
    // Scotland, at a zoom the map can actually show.
    if (Array.isArray(c) && c.length === 2 && num(c[0]) && num(c[1])
        && c[1] > 50 && c[1] < 70 && c[0] > -12 && c[0] < 4
        && num(v.zoom) && v.zoom >= 1 && v.zoom <= 20) {
      out.view = { center: [c[0], c[1]], zoom: v.zoom };
    }
  }

  const filters = (doc as Record<string, unknown>).filters;
  if (typeof filters === 'object' && filters !== null) {
    const f: Record<string, string> = {};
    for (const [k, v] of Object.entries(filters as Record<string, unknown>)) {
      if (typeof v === 'string' && v.length < 32) f[k] = v;
    }
    if (Object.keys(f).length) out.filters = f;
  }

  const selected = (doc as Record<string, unknown>).selected;
  if (typeof selected === 'object' && selected !== null) {
    const s = selected as Record<string, unknown>;
    if ((s.kind === 'reach' || s.kind === 'group' || s.kind === 'known')
        && typeof s.id === 'string' && s.id.length > 0 && s.id.length < 128) {
      out.selected = { kind: s.kind, id: s.id };
    }
  }

  return out;
}

/** Merge a patch over whatever is stored now. Fails soft: if storage is
 *  unavailable (private mode, full quota) the app runs, it just forgets. */
export function saveState(patch: Partial<SavedState>): void {
  const doc: SavedState = { ...loadState() };
  for (const [k, v] of Object.entries(patch) as [keyof SavedState, unknown][]) {
    if (v === undefined) continue;
    (doc as Record<string, unknown>)[k] = v;
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(doc));
  } catch {
    // nothing to do — see above
  }
}

/** The preset whose slider set exactly matches the saved one, if any. */
export function presetFor(filters: Record<string, string> | undefined): string | null {
  if (!filters) return null;
  for (const [name, values] of Object.entries(PRESETS)) {
    if (Object.entries(values).every(([id, v]) => filters[id] === String(v))) return name;
  }
  return null;
}
