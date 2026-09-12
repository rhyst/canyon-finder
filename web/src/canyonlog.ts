/** Canyon Log's grading vocabulary, as it appears in `known.json`.
 * Visit reports speak the same one: 0 = not worth it, 1+ = worth it. */
import type { Candidate, KnownCanyon, VisitReport } from './types.ts';
import { esc, safeUrl } from './format.ts';

/** Grades that mean someone descended it and rated it worth doing. */
export const GRADED = ['Basic', 'Moderate', 'Advanced'];

/** Visited and reported as not worth the walk — the search's true negatives. */
export const ZERO_STAR = '0 Stars';

/** `source` on entries the visit stage created rather than the Canyon Log stage. */
export const VISIT_SOURCE = 'visit';

/** A 0 on Canyon Log, or every visit report at 0, means not worth the walk. */
export function isDud(k: KnownCanyon): boolean {
  if (k.category === ZERO_STAR) return true;
  return k.source === VISIT_SOURCE && (k.visits?.length ?? 0) > 0
    && k.visits!.every((v) => v.stars === 0);
}

/** At least one visit report says worth it — isDud's positive counterpart. */
export function isWorthwhile(k: KnownCanyon): boolean {
  return isGraded(k) || (k.visits ?? []).some((v) => v.stars >= 1);
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

/** The tag shown on a visit report: Canyon Log vocabulary, stars for the rest. */
export function visitStars(v: VisitReport): { text: string; dud: boolean } {
  return v.stars === 0
    ? { text: 'not worth it', dud: true }
    : { text: '★'.repeat(v.stars), dud: false };
}

/**
 * The numbers the detail card shows: the pipeline's measurements, replaced by
 * a reporter's corrections when one is present. Pure on purpose — the card's
 * "reported vs measured" line is a test.
 */
export function reportedStats(k: KnownCanyon): {
  gradient: number; drop: number; length: number; corrected: boolean;
} {
  const c = k.visits?.find((v) => v.corrections)?.corrections;
  const drop = c?.drop_m ?? k.drop;
  const length = c?.length_m ?? k.length;
  return { drop, length, gradient: length > 0 ? drop / length : 0,
           corrected: Boolean(c && (c.drop_m != null || c.length_m != null)) };
}

/** Community visit reports: one block per report, every field escaped.
 * Image paths are pipeline-generated from a validated filename, so esc() is
 * the guard there; external links go through the safeUrl allowlist. */
export function visitReportsHtml(k: KnownCanyon): string {
  return (k.visits ?? []).map((v) => {
    const s = visitStars(v);
    const bits: string[] = [];
    if (v.grade) bits.push(esc(v.grade));
    if (v.pitches != null) bits.push(`${v.pitches} pitch${v.pitches === 1 ? '' : 'es'}`);
    if (v.highestPitchM != null) bits.push(`highest ${v.highestPitchM} m`);
    const imgs = (v.images ?? []).map((im) =>
      `<a class="visit-img" href="${esc(im.url)}" target="_blank" rel="noreferrer">` +
      `<img src="${esc(im.url)}" alt="${esc(im.caption ?? im.file)}" loading="lazy"></a>`)
      .join('');
    const links = (v.links ?? [])
      .filter((l) => Boolean(safeUrl(l)))
      .map((l) =>
        `<a target="_blank" rel="noreferrer" href="${safeUrl(l)}">` +
        `${esc(new URL(l).hostname)}</a>`)
      .join(' ');
    return `<div class="visit">
      <div class="visit-head">
        <span class="visit-author">${esc(v.author)}</span>
        <span class="visit-date">${esc(v.date)}</span>
        <span class="tag mini${s.dud ? ' dud' : ''}">${s.text}</span>
      </div>
      ${v.description ? `<p class="visit-desc">${esc(v.description).replace(/\n/g, '<br>')}</p>` : ''}
      ${bits.length ? `<div class="visit-meta">${bits.join(' · ')}</div>` : ''}
      ${imgs ? `<div class="visit-imgs">${imgs}</div>` : ''}
      ${links ? `<div class="visit-links">${links}</div>` : ''}
    </div>`;
  }).join('');
}
