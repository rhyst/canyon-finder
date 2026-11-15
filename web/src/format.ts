/**
 * The lines the detail card shows. Pure string building, kept out of main.ts so
 * the numbers can be tested — an undefined here renders as "NaN" to the user.
 */
import type { Group } from './grouping.ts';
import type { Candidate, ScoreModel } from './types.ts';

/**
 * Escape text bound for innerHTML. Canyon Log's names, grades and categories come
 * from someone else's CMS, so they are the one input here that nobody in this
 * project controls.
 */
export function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]!));
}

/**
 * A link target from that same CMS, or '' if it is not plainly a web address.
 * An allowlist rather than a blocklist: `javascript:` in an href runs on click,
 * and there is no reason a Canyon Log entry needs any other scheme.
 */
export function safeUrl(url: string): string {
  try {
    const u = new URL(url, 'https://canyonlog.org');
    return u.protocol === 'https:' || u.protocol === 'http:' ? esc(u.href) : '';
  } catch {
    return '';
  }
}

/** Drainage area, at a precision that suits its size. */
export function fmtArea(km2: number): string {
  return `${km2 < 10 ? km2.toFixed(1) : km2.toFixed(0)} km²`;
}

/** Where a section sits among every section in Great Britain. */
export function rankText(rank: number): string {
  return `top ${Math.max(1, Math.ceil(rank * 100))}%`;
}

export interface Badge { label: string; title: string; weak?: boolean }

/** What makes a section a prospect, each shown only when it is as strong as
 *  the median rated canyon. Weak badges are cautions, not strengths. */
export function badges(c: Candidate, model: ScoreModel | null): Badge[] {
  const out: Badge[] = [];
  const b = model?.badges;
  if (b) {
    const pct = (v: number) => `${(v * 100).toFixed(0)}%`;
    if (c.gradient >= b.gradient) {
      out.push({ label: 'steep', title: `${pct(c.gradient)} overall; half of rated canyons reach ${pct(b.gradient)}` });
    }
    if (c.drop >= b.drop) {
      out.push({ label: 'big drop', title: `${c.drop.toFixed(0)} m; half of rated canyons reach ${b.drop.toFixed(0)} m` });
    }
    if (c.steepest >= b.steepest) {
      out.push({ label: 'falls', title: `steepest 100 m is ${pct(c.steepest)}; half of rated canyons reach ${pct(b.steepest)}` });
    }
    if (c.confine >= b.confine) {
      out.push({ label: 'confined', title: `valley sides rise ${c.confine.toFixed(0)} m; half of rated canyons reach ${b.confine.toFixed(0)} m` });
    }
    const [lo, hi] = b.water;
    const range = `most rated canyons drain ${fmtArea(lo)} to ${fmtArea(hi)}`;
    if (c.drain < lo) out.push({ label: 'little water', title: `${fmtArea(c.drain)}; ${range}`, weak: true });
    else if (c.drain > hi) out.push({ label: 'big water', title: `${fmtArea(c.drain)}; ${range}`, weak: true });
    else out.push({ label: 'good water', title: `${fmtArea(c.drain)}; ${range}` });
  }
  if (c.dem !== '50 m') out.push({ label: 'lidar', title: `measured on ${c.dem}` });
  else out.push({ label: '50 m model', title: 'coarse elevation: falls and gorge walls are smoothed', weak: true });
  if (c.dam) out.push({ label: 'dam', title: 'at or just below a mapped dam', weak: true });
  return out;
}

export function badgesHtml(list: Badge[]): string {
  return list.map((b) =>
    `<span class="tag mini badge${b.weak ? ' weak' : ''}" title="${esc(b.title)}">${b.label}</span>`)
    .join(' ');
}

export interface Context {
  /** Whether a Canyon Log entry sits on this water. */
  logged: boolean;
  /** Which ones, when the entry's window overlaps this water's sections. */
  loggedNames?: string[];
}

/** The watercourse summary — the context a single section sits in. */
export function watercourseLine(group: Group, ctx: Context): string {
  const n = group.members.length;
  const label = ctx.loggedNames?.length
    ? `logged: ${esc(ctx.loggedNames.slice(0, 2).join(', '))}` +
      (ctx.loggedNames.length > 2 ? ` +${ctx.loggedNames.length - 2}` : '')
    : 'logged';
  const logged = ctx.logged ? `<span class="tag mini">${label}</span> · ` : '';
  return `${logged}${n === 1 ? 'one steep section' : `${n} steep sections · ` +
    `${group.drop.toFixed(0)} m of drop in ${(group.length / 1000).toFixed(2)} km`}`;
}

export function sectionLine(c: Candidate, scored: boolean): string {
  const p = scored ? `<span class="promise">${rankText(c.rank)}</span> · ` : '';
  return `${p}${(c.gradient * 100).toFixed(1)}% over ${c.length.toFixed(0)} m · ` +
    `${c.drop.toFixed(0)} m drop · steepest 100 m ${(c.steepest * 100).toFixed(0)}% · ` +
    `${c.top.toFixed(0)}→${c.bottom.toFixed(0)} m · ${fmtArea(c.drain)} draining · ` +
    `confinement ${c.confine.toFixed(0)} m`;
}
