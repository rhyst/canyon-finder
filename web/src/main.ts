import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import {
  Map as MapLibreMap,
  setWorkerUrl,
  NavigationControl,
  Popup,
  ScaleControl,
  type GeoJSONSource,
  type MapLayerMouseEvent,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// MapLibre resolves its worker relative to its own module URL, which breaks once
// the entry is bundled; hand it a URL Vite emits instead.
setWorkerUrl(maplibreWorkerUrl);
import type {
  Candidate, KnownCanyon, Payload, Query, ScoreModel, SortKey,
} from './types';
import { PRESETS } from './presets';
import {
  buildGroups, buildRows, candId, findRow, groupOf, groupScore, loggedOn, nearestLogged,
  type Group, type GroupModel, type Row,
} from './grouping';
import { covered, isDud, isGraded } from './canyonlog';
import { esc, fmtArea, reachLine, safeUrl, watercourseLine } from './format';
import { loadState, presetFor, saveState, type SavedSelection } from './state';

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });

// Last session, if any. Restored before the worker's ready message applies a
// preset and runs the first search, so the restore cannot be clobbered.
const saved = loadState();
// The style cannot carry the saved basemap, so pick the visible layer here.
const savedBasemap = saved.filters?.basemap === 'sat' ? 'sat' : 'topo';

const BASEMAPS: Record<string, { tiles: string[]; attribution: string; maxzoom: number }> = {
  topo: {
    tiles: ['https://tile.opentopomap.org/{z}/{x}/{y}.png'],
    attribution: '© OpenTopoMap (CC-BY-SA) · © OpenStreetMap contributors',
    maxzoom: 17,
  },
  sat: {
    tiles: [
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    ],
    attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
    maxzoom: 19,
  },
};

function applyPreset(name: string) {
  const preset = PRESETS[name];
  if (!preset) return;
  for (const [id, value] of Object.entries(preset)) {
    const input = el<HTMLInputElement | HTMLSelectElement>(id);
    if (input) input.value = String(value);
  }
  run();
}

const map = new MapLibreMap({
  container: 'map',
  center: saved.view?.center ?? [-4.6, 56.9],
  zoom: saved.view?.zoom ?? 6.4,
  style: {
    version: 8,
    sources: Object.fromEntries(Object.entries(BASEMAPS).map(([k, b]) => [
      `base-${k}`,
      { type: 'raster', tiles: b.tiles, tileSize: 256, maxzoom: b.maxzoom,
        attribution: b.attribution },
    ])),
    layers: Object.keys(BASEMAPS).map((k) => ({
      id: `base-${k}`,
      type: 'raster' as const,
      source: `base-${k}`,
      layout: { visibility: k === savedBasemap ? ('visible' as const) : ('none' as const) },
    })),
  },
});
map.addControl(new NavigationControl({ visualizePitch: false }), 'top-right');
map.addControl(new ScaleControl({ unit: 'metric' }));

let payload: Payload;
let known: KnownCanyon[] = []; // community-logged descents, for calibration
let graded: KnownCanyon[] = []; // the graded ones: catching a 0-star is no virtue
let scoreModel: ScoreModel | null = null;
let groupModel: GroupModel | null = null;
const promise = new Map<string, number>(); // group key -> fitted probability
const nearby = new Map<string, number>(); // group key -> metres to nearest logged
const loggedHere = new Map<string, string[]>(); // group key -> logged canyons on it
let results: Candidate[] = []; // everything the worker returned
let view: Candidate[] = []; // filtered + sorted
let rows: Row[] = []; // exactly what the list shows: group headers plus expanded reaches
let selected = -1; // index into `rows`
let stats = { scanned: 0, ms: 0, totalReaches: 0, truncated: false };
let queryId = 0;
let ready = false;
// The saved selection, re-applied once the rows for it exist.
let pendingSelection: SavedSelection | null = saved.selected ?? null;
// Artifacts built against a different payload, dropped rather than trusted.
const stale: string[] = [];

const empty = { type: 'FeatureCollection', features: [] } as const;
// Within this distance a candidate is the same water as a logged entry.
const LOGGED_RADIUS = 250;
// Top of the drainage ceiling slider means "no ceiling" rather than 200 km2.
const DRAIN_NO_LIMIT = 200;

map.on('load', () => {
  map.addSource('reaches', { type: 'geojson', data: empty as never });
  map.addSource('reach-points', { type: 'geojson', data: empty as never });
  map.addSource('picked', { type: 'geojson', data: empty as never });
  map.addSource('known', { type: 'geojson', data: knownGeoJSON() as never });
  map.addSource('known-points', { type: 'geojson', data: knownPointGeoJSON() as never });

  // Gradient is magnitude, so one hue with monotone lightness — validated with
  // the dataviz skill's validateOrdinal (monotone L, adjacent dL >= 0.06, hue
  // spread 29 deg). Anchored dark-end-low because the map surface is dark: steep
  // water brightens rather than recedes. Contrast against any basemap comes from
  // the casing beneath, not from the ramp.
  const GRADIENT_RAMP = [
    'interpolate', ['linear'], ['get', 'gradient'],
    0.05, '#8a4a12',
    0.12, '#c26a1c',
    0.20, '#e8912b',
    0.30, '#ffb54d',
    0.45, '#ffdc94',
  ];
  const ROUND = { 'line-cap': 'round' as const, 'line-join': 'round' as const };

  // Selection sits *under* the data as a soft white glow, so a selected reach
  // keeps its gradient colour instead of being repainted.
  map.addLayer({
    id: 'picked',
    type: 'line',
    source: 'picked',
    layout: ROUND,
    paint: {
      'line-color': '#ffffff',
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 8, 15, 20],
      'line-blur': 2,
      'line-opacity': 0.85,
    },
  });
  map.addLayer({
    id: 'reaches-casing',
    type: 'line',
    source: 'reaches',
    layout: ROUND,
    paint: {
      'line-color': '#12181d',
      'line-width': ['interpolate', ['linear'], ['zoom'], 11, 6, 15, 11],
      'line-opacity': ['interpolate', ['linear'], ['zoom'], 10, 0, 11.5, 0.8],
    },
  });
  map.addLayer({
    id: 'reaches',
    type: 'line',
    source: 'reaches',
    layout: ROUND,
    paint: {
      'line-width': ['interpolate', ['linear'], ['zoom'], 11, 2.5, 15, 6],
      'line-color': GRADIENT_RAMP as never,
      'line-opacity': ['interpolate', ['linear'], ['zoom'], 10, 0, 11.5, 1],
    },
  });
  map.addLayer({
    id: 'reach-dots',
    type: 'circle',
    source: 'reach-points',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 2.5, 11, 5.5],
      'circle-color': GRADIENT_RAMP as never,
      'circle-stroke-color': '#12181d',
      'circle-stroke-width': 1,
      'circle-opacity': ['interpolate', ['linear'], ['zoom'], 10, 0.9, 11.5, 0],
      'circle-stroke-opacity': ['interpolate', ['linear'], ['zoom'], 10, 0.9, 11.5, 0],
    },
  });
  // A 300 m reach is sub-pixel below about zoom 11, so lines hand over to dots
  // there: fade one in as the other goes out.
  map.addLayer({
    id: 'known-casing',
    type: 'line',
    source: 'known',
    layout: ROUND,
    paint: {
      'line-color': '#12181d',
      'line-width': ['interpolate', ['linear'], ['zoom'], 11, 7, 15, 12],
      'line-opacity': ['interpolate', ['linear'], ['zoom'], 10, 0, 11.5, 0.8],
    },
  });
  map.addLayer({
    id: 'known',
    type: 'line',
    source: 'known',
    layout: ROUND,
    paint: {
      'line-color': ['case', ['get', 'dud'], '#8b97a3', '#5ec98a'],
      'line-width': ['interpolate', ['linear'], ['zoom'], 11, 3, 15, 6],
      'line-dasharray': [2, 1.4],
      'line-opacity': ['interpolate', ['linear'], ['zoom'], 10, 0, 11.5, 1],
    },
  });
  map.addLayer({
    id: 'known-dots',
    type: 'circle',
    source: 'known-points',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 3.5, 11, 7],
      'circle-color': ['case', ['get', 'dud'], '#8b97a3', '#5ec98a'],
      'circle-stroke-color': '#12181d',
      'circle-stroke-width': 1.5,
      'circle-opacity': ['interpolate', ['linear'], ['zoom'], 10, 1, 11.5, 0],
      'circle-stroke-opacity': ['interpolate', ['linear'], ['zoom'], 10, 1, 11.5, 0],
    },
  });

  for (const id of ['reaches', 'reach-dots']) {
    map.on('click', id, (e: MapLayerMouseEvent) => {
      const hit = e.features?.[0]?.properties?.rid;
      if (hit !== undefined) selectCandidate(String(hit));
    });
    map.on('mouseenter', id, () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', id, () => (map.getCanvas().style.cursor = ''));
  }
  map.on('click', 'known', (e: MapLayerMouseEvent) => {
    const idx = e.features?.[0]?.properties?.idx;
    if (idx !== undefined) selectKnown(Number(idx));
  });
  map.on('click', 'known-dots', (e: MapLayerMouseEvent) => {
    const idx = e.features?.[0]?.properties?.idx;
    if (idx !== undefined) selectKnown(Number(idx));
  });
  for (const id of ['known', 'known-dots']) {
    map.on('mouseenter', id, () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', id, () => (map.getCanvas().style.cursor = ''));
  }
  // The style cannot carry the saved "logged" visibility either.
  if (!el<HTMLInputElement>('showKnown').checked) {
    for (const id of ['known', 'known-casing', 'known-dots']) {
      map.setLayoutProperty(id, 'visibility', 'none');
    }
  }
  map.on('moveend', () => {
    const c = map.getCenter();
    saveState({ view: { center: [c.lng, c.lat], zoom: map.getZoom() } });
    if (el<HTMLInputElement>('viewOnly').checked) renderResults();
  });
  // The worker may have finished first: its render could not reach the map
  // (these sources did not exist yet), so draw that now. Deliberately not a
  // full renderResults — repainting the list would reset its scroll and
  // strand a just-restored selection back at the top.
  if (results.length) drawReaches(view);
  tryRestoreSelection();
});

function knownPointGeoJSON() {
  return {
    type: 'FeatureCollection',
    features: known.map((k, idx) => ({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: k.coords[Math.floor(k.coords.length / 2)],
      },
      properties: { idx, name: k.name, dud: isDud(k) },
    })),
  };
}

function knownGeoJSON() {
  return {
    type: 'FeatureCollection',
    features: known.map((k, idx) => ({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: k.coords },
      properties: { idx, name: k.name, gradient: k.gradient, dud: isDud(k) },
    })),
  };
}

/* ---------- data load ---------- */

async function boot() {
  const [meta, bin, knownDoc, score, groups] = await Promise.all([
    fetch('data/profiles.json').then((r) => r.json()),
    fetch('data/profiles.bin').then((r) => r.arrayBuffer()),
    fetch('data/known.json').then((r) => (r.ok ? r.json() : { canyons: [] }))
      .catch(() => ({ canyons: [] })),
    fetch('data/score.json').then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetch('data/group-score.json').then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  payload = meta;
  // known.json addresses the payload by (chain, i, j) and both models were fitted
  // on reaches found in it. If any of them was built against a different payload,
  // using it anyway means logged canyons drawn on the wrong burn and a promise
  // column scored against reaches that no longer exist — wrong, and quietly so.
  // Dropping what does not match is worse-looking and better.
  const fresh = <T extends { index_id?: string }>(doc: T | null, name: string) => {
    if (!doc || !meta.index_id || doc.index_id === meta.index_id) return doc;
    stale.push(name);
    return null;
  };
  scoreModel = fresh(score, 'score.json');
  groupModel = fresh(groups, 'group-score.json');
  const usableKnown = fresh(knownDoc, 'known.json');
  known = ((usableKnown?.canyons ?? []) as KnownCanyon[]).map((k) => ({
    ...k,
    lon: k.coords[0][0],
    lat: k.coords[0][1],
  }));
  graded = known.filter(isGraded);
  if (map.getSource('known')) {
    (map.getSource('known') as GeoJSONSource).setData(knownGeoJSON() as never);
    (map.getSource('known-points') as GeoJSONSource).setData(knownPointGeoJSON() as never);
  }
  el('dem').textContent = payload.dem;
  worker.postMessage({ type: 'init', meta, bin, score: scoreModel }, [bin]);
}

worker.onmessage = (e: MessageEvent) => {
  const msg = e.data;
  if (msg.type === 'ready') {
    ready = true;
    // A restored 'custom' panel has no preset to apply; search against the
    // restored sliders instead, or the first query never runs.
    const preset = el<HTMLSelectElement>('preset').value;
    if (PRESETS[preset]) applyPreset(preset);
    else run();
  } else if (msg.type === 'results') {
    if (msg.id !== queryId) return;
    results = msg.candidates;
    stats = {
      scanned: msg.scanned, ms: msg.ms,
      totalReaches: msg.totalReaches, truncated: msg.truncated,
    };
    renderResults();
    tryRestoreSelection();
  } else if (msg.type === 'profile') {
    drawProfile(msg.points);
  }
};

/* ---------- query ---------- */

function readQuery(): Query {
  const num = (id: string) => Number(el<HTMLInputElement>(id).value);
  let minGrad = num('minGrad') / 100;
  let maxGrad = num('maxGrad') / 100;
  if (maxGrad < minGrad) maxGrad = minGrad;
  let minLen = num('minLen');
  let maxLen = num('maxLen');
  if (maxLen < minLen) maxLen = minLen;

  el('gradOut').textContent = `${(minGrad * 100).toFixed(0)}–${(maxGrad * 100).toFixed(0)}%`;
  el('lenOut').textContent = `${minLen}–${maxLen} m`;
  const maxDrain = num('maxDrain');
  el('drainOut').textContent = maxDrain >= DRAIN_NO_LIMIT
    ? `${num('minDrain')} km² +`
    : `${num('minDrain')}–${maxDrain} km²`;
  el('confOut').textContent = `${num('minConf')} m`;
  el('altOut').textContent = `${num('minAlt')} m`;

  return {
    minGradient: minGrad,
    maxGradient: maxGrad,
    minLength: minLen,
    maxLength: maxLen,
    minDrain: num('minDrain'),
    maxDrain: maxDrain >= DRAIN_NO_LIMIT ? Infinity : maxDrain,
    // The channel-length bound stays in the engine for tools/thresholds.ts to
    // measure against; the UI does not expose it.
    minCatchment: 0,
    maxCatchment: Infinity,
    minConfine: num('minConf'),
    minAltitude: num('minAlt'),
    sort: el<HTMLSelectElement>('sort').value as SortKey,
  };
}

function run() {
  const q = readQuery();
  if (!ready) return;
  queryId++;
  el('status').textContent = 'Searching…';
  worker.postMessage({ type: 'query', id: queryId, query: q });
}

const expanded = new Set<string>();
// The list is not capped; it renders this many rows at a time as you scroll.
const CHUNK = 120;
let renderedRows = 0;
let sentinel: HTMLLIElement | null = null;

function renderResults(keepPlace = false) {
  const q = readQuery();
  let list = results;
  if (el<HTMLInputElement>('viewOnly').checked) {
    const b = map.getBounds();
    list = list.filter((c) => b.contains([c.lon, c.lat]));
  }
  const key = q.sort as keyof Candidate;
  const memberKey = (q.sort === 'promise' ? 'score' : key) as keyof Candidate;
  view = [...list].sort((a, b) => (b[memberKey] as number) - (a[memberKey] as number));
  let groups = buildGroups(view, q.sort, payload.spacing, groupModel);

  promise.clear();
  nearby.clear();
  loggedHere.clear();
  for (const g of groups) {
    promise.set(g.key, groupScore(g, groupModel));
    nearby.set(g.key, nearestLogged(g, known));
    const on = loggedOn(g, known);
    if (on.length) loggedHere.set(g.key, on.map((k) => k.name));
  }
  if (el<HTMLInputElement>('hideLogged').checked) {
    // Overlap first — a canyon whose window sits on this water — with the
    // distance as a fallback for entries that snapped to a neighbouring burn.
    groups = groups.filter((g) => !loggedHere.has(g.key)
      && (nearby.get(g.key) ?? Infinity) > LOGGED_RADIUS);
    // Set membership, not a scan per candidate: with nothing capped this runs
    // over tens of thousands of reaches and as many groups.
    const keep = new Set(groups.map((g) => g.key));
    view = view.filter((c) => keep.has(groupOf(c)));
  }

  // Measured against everything the search found, not the displayed subset, so
  // it reports what the filters reach rather than what the view toggles show.
  const hit = covered(graded, results).length;
  const took = stats.ms >= 1000 ? `${(stats.ms / 1000).toFixed(1)} s` : `${stats.ms.toFixed(0)} ms`;
  el('status').innerHTML =
    `${groups.length.toLocaleString()} watercourses · ` +
    `${view.length.toLocaleString()} reaches · ${took}` +
    (stats.truncated ? ' · <span class="trunc">search truncated</span>' : '') +
    (graded.length ? ` · <span class="known-hit">catches ${hit}/${graded.length} ` +
      `logged descents</span>` : '') +
    (stale.length ? ` · <span class="trunc">ignoring ${esc(stale.join(', '))}: ` +
      `built against a different payload, re-run the pipeline</span>` : '');

  rows = buildRows(groups, expanded);

  paintRows(keepPlace);
  drawReaches(view);
}

/** Rebuild the visible list. `keepPlace` holds the scroll position and depth,
 *  which matters when expanding a group rather than running a new query. */
function paintRows(keepPlace = false) {
  const ul = el<HTMLUListElement>('results');
  const top = ul.scrollTop;
  const depth = keepPlace ? Math.max(renderedRows, CHUNK) : CHUNK;
  ul.replaceChildren();
  renderedRows = 0;
  appendRows(depth);
  if (keepPlace) ul.scrollTop = top;
  else ul.scrollTop = 0;
}

function appendRows(count: number) {
  const ul = el<HTMLUListElement>('results');
  const end = Math.min(rows.length, renderedRows + count);
  const frag = document.createDocumentFragment();
  for (let i = renderedRows; i < end; i++) frag.append(renderRow(rows[i], i));
  sentinel?.remove();
  ul.append(frag);
  renderedRows = end;
  if (renderedRows < rows.length) {
    sentinel ??= document.createElement('li');
    sentinel.className = 'sentinel';
    sentinel.textContent = `${(rows.length - renderedRows).toLocaleString()} more…`;
    ul.append(sentinel);
    moreObserver.observe(sentinel);
  }
}

const moreObserver = new IntersectionObserver((entries) => {
  if (entries.some((e) => e.isIntersecting)) appendRows(CHUNK);
}, { root: el('results'), rootMargin: '200px' });

/** Render far enough down the list that row `idx` exists in the DOM. */
function ensureRendered(idx: number) {
  if (idx >= renderedRows) appendRows(idx - renderedRows + CHUNK);
}

function renderRow(row: Row, i: number): HTMLLIElement {
  const li = document.createElement('li');
  li.setAttribute('aria-selected', String(i === selected));
  const { group, cand } = row;

  if (cand) {
    li.className = 'reach';
    li.innerHTML = `
      <span class="name">${cand.drop.toFixed(0)} m over ${cand.length.toFixed(0)} m</span>
      <span class="grad">${(cand.gradient * 100).toFixed(0)}%</span>
      <span class="meta">steepest 100 m ${(cand.steepest * 100).toFixed(0)}% ·
        confinement ${cand.confine.toFixed(0)} m · ${fmtArea(cand.drain)} draining ·
        top ${cand.top.toFixed(0)} m</span>`;
  } else {
    const n = group.members.length;
    li.className = 'group';
    const multi = n > 1;
    li.innerHTML = `
      <span class="name">${multi ? `<span class="chev">${expanded.has(group.key)
        ? '▾' : '▸'}</span> ` : ''}${group.name}</span>
      <span class="grad">${(group.best.gradient * 100).toFixed(0)}%</span>
      <span class="meta">${groupModel
        ? `<span class="promise">promise ${(promise.get(group.key)! * 100).toFixed(0)}</span> · `
        : ''}${loggedTag(group)}${multi
        ? `${n} reaches · ${group.steepDrop.toFixed(0)} m of drop in
           ${(group.steepLength / 1000).toFixed(1)} km of steep channel ·
           ${group.spanDrop.toFixed(0)} m over a ${(group.spanLength / 1000).toFixed(1)} km span`
        : `${group.best.drop.toFixed(0)} m over ${group.best.length.toFixed(0)} m ·
           steepest 100 m ${(group.best.steepest * 100).toFixed(0)}%`} ·
        ${fmtArea(group.best.drain)} draining · ${group.best.dem} DEM</span>`;
  }

  li.onclick = (e) => {
    if (!cand && group.members.length > 1
        && (e.target as HTMLElement).classList.contains('chev')) {
      if (expanded.has(group.key)) expanded.delete(group.key);
      else expanded.add(group.key);
      renderResults(true);
      return;
    }
    select(i);
  };
  return li;
}

function drawReaches(list: Candidate[]) {
  const props = (c: Candidate) => ({ rid: candId(c), gradient: c.gradient, name: c.name });
  (map.getSource('reaches') as GeoJSONSource | undefined)?.setData({
    type: 'FeatureCollection',
    features: list.map((c) => ({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: c.coords },
      properties: props(c),
    })),
  } as never);
  (map.getSource('reach-points') as GeoJSONSource | undefined)?.setData({
    type: 'FeatureCollection',
    features: list.map((c) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: c.coords[Math.floor(c.coords.length / 2)] },
      properties: props(c),
    })),
  } as never);
}

/* ---------- selection + detail ---------- */

/** Select by candidate identity, expanding its group so the row is visible. */
function selectCandidate(id: string) {
  const target = view.find((c) => candId(c) === id);
  if (!target) return;
  const key = groupOf(target);
  const group = rows.find((r) => r.group.key === key)?.group;
  if (group && group.members.length > 1 && !expanded.has(key)) {
    expanded.add(key);
    renderResults(true);
  }
  const at = findRow(rows, id);
  if (at >= 0) select(at);
}

function contextOf(group: Group) {
  return {
    promise: groupModel ? (promise.get(group.key) ?? 0) : null,
    logged: loggedHere.has(group.key)
      || (nearby.get(group.key) ?? Infinity) <= LOGGED_RADIUS,
    loggedNames: loggedHere.get(group.key),
  };
}

/** The "logged" tag for a list row: which canyons sit on this water when the
 *  windows say so, the bare tag when only proximity does. */
function loggedTag(group: Group): string {
  const names = loggedHere.get(group.key);
  if (names?.length) {
    return `<span class="tag mini">logged: ${esc(names.slice(0, 2).join(', '))}` +
      (names.length > 2 ? ` +${names.length - 2}` : '') + '</span> · ';
  }
  return (nearby.get(group.key) ?? Infinity) <= LOGGED_RADIUS
    ? '<span class="tag mini">logged</span> · ' : '';
}

function select(idx: number) {
  const row = rows[idx];
  if (!row) return;
  selected = idx;
  const { group, cand } = row;
  saveState({ selected: cand
    ? { kind: 'reach', id: candId(cand) }
    : { kind: 'group', id: group.key } });

  if (cand) {
    // A reach is only meaningful against the watercourse it belongs to, so show
    // both: the burn as a whole, then this section of it.
    const at = group.members.indexOf(cand) + 1;
    showDetail({
      coords: [cand.coords],
      title: `${group.name}` + (group.members.length > 1
        ? ` <span class="tag alt">reach ${at} of ${group.members.length}</span>`
        : ''),
      context: watercourseLine(group, contextOf(group)),
      stats: reachLine(cand),
      chain: cand.chain,
      i: cand.i,
      j: cand.j,
      extra: '',
    });
  } else {
    const first = group.members[0];
    const last = group.members[group.members.length - 1];
    showDetail({
      coords: group.members.map((c) => c.coords),
      title: group.name,
      context: watercourseLine(group, contextOf(group)),
      stats: group.members.length > 1
        ? `best reach: ${reachLine(group.best)}`
        : reachLine(first),
      chain: group.chain,
      i: first.i,
      j: last.j,
      extra: '',
    });
  }

  ensureRendered(idx);
  highlight(idx);
}

/** Mark row `idx` selected in the list and bring it into view. Synchronous on
 *  purpose: a deferred scroll races the repaints that can follow a restore
 *  (a view-only re-render on moveend, a later query) and loses, leaving the
 *  selection highlighted but off-screen. */
function highlight(idx: number) {
  const items = el<HTMLUListElement>('results').children;
  for (let k = 0; k < items.length; k++) {
    items[k].setAttribute('aria-selected', String(k === idx));
  }
  items[idx]?.scrollIntoView({ block: 'center', behavior: 'auto' });
}

function selectKnown(idx: number) {
  const k = known[idx];
  if (!k) return;
  selected = -1;
  saveState({ selected: { kind: 'known', id: `${k.chain}:${k.i}:${k.j}` } });
  const grade = k.grade ? `${esc(k.grade)} · ` : '';
  const dud = isDud(k);
  showDetail({
    coords: [k.coords],
    title: `${esc(k.name)} <span class="tag${dud ? ' dud' : ''}">` +
      `${dud ? '0 stars' : 'logged'}</span>`,
    stats: `${grade}${dud ? 'visited, reported not worth it' : esc(k.category) || 'ungraded'}` +
      ` · measured ` +
      `${(k.gradient * 100).toFixed(1)}% over ${k.length.toFixed(0)} m ` +
      `(${k.drop.toFixed(0)} m) on ${esc(k.watercourse) || 'an unnamed burn'}`,
    chain: k.chain,
    i: k.i,
    j: k.j,
    extra: safeUrl(k.url)
      ? `<a target="_blank" rel="noreferrer" href="${safeUrl(k.url)}">Canyon Log</a>`
      : '',
  });

  // Tie the canyon back to its watercourse in the list: highlight the group
  // whose reaches its window sits on, so the list shows where it belongs — and
  // clears cleanly when the current filters leave its water out. Best effort in
  // the same way the saved-selection restore is.
  const at = rows.findIndex((r) => !r.cand && loggedOn(r.group, [k]).length > 0);
  selected = at;
  if (at >= 0) ensureRendered(at);
  highlight(at);
}

interface Detail {
  coords: [number, number][][];
  title: string;
  context?: string; // the watercourse the reach belongs to
  stats: string;
  chain: number;
  i: number;
  j: number;
  extra: string;
}

function showDetail(info: Detail) {
  (map.getSource('picked') as GeoJSONSource | undefined)?.setData({
    type: 'Feature',
    geometry: { type: 'MultiLineString', coordinates: info.coords },
    properties: {},
  } as never);

  const flat = info.coords.flat();
  const lons = flat.map((p) => p[0]);
  const lats = flat.map((p) => p[1]);

  const lat = lats[0];
  const lon = lons[0];
  const d = el('detail');
  d.hidden = false;
  d.innerHTML = `
    <button class="zoom" aria-label="Zoom to feature" title="Zoom to feature">
      <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
        <circle cx="6.5" cy="6.5" r="4.6" fill="none" stroke="currentColor" stroke-width="1.6"/>
        <path d="M10 10l4.2 4.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
      </svg>
    </button>
    <button class="close" aria-label="Close" title="Close">×</button>
    <h2>${info.title}</h2>
    ${info.context ? `<div class="stats context">${info.context}</div>` : ''}
    <div class="stats">${info.stats}</div>
    <div id="chart"></div>
    <div class="links">
      ${info.extra}
      <a target="_blank" rel="noreferrer"
         href="https://explore.osmaps.com/?lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}&zoom=15">OS Maps</a>
      <a target="_blank" rel="noreferrer"
         href="https://www.google.com/maps/@${lat.toFixed(5)},${lon.toFixed(5)},600m/data=!3m1!1e3">Satellite</a>
      <a href="#" id="copy">Copy ${lat.toFixed(5)}, ${lon.toFixed(5)}</a>
    </div>`;
  // Selecting never moves the map — it is jarring when the click came from the
  // map itself — so fitting the view to the feature is the button's job.
  d.querySelector<HTMLButtonElement>('button.zoom')!.onclick = () => {
    map.fitBounds(
      [
        [Math.min(...lons), Math.min(...lats)],
        [Math.max(...lons), Math.max(...lats)],
      ],
      { padding: 120, maxZoom: 15, duration: 600 },
    );
  };
  d.querySelector<HTMLButtonElement>('button.close')!.onclick = () => {
    d.hidden = true;
    saveState({ selected: null });
  };
  d.querySelector<HTMLAnchorElement>('#copy')!.onclick = (e) => {
    e.preventDefault();
    navigator.clipboard.writeText(`${lat.toFixed(5)}, ${lon.toFixed(5)}`);
  };
  worker.postMessage({ type: 'profile', id: queryId, chain: info.chain, i: info.i, j: info.j });
}

function drawProfile(points: { d: number; z: number; inside: boolean }[]) {
  const host = document.getElementById('chart');
  if (!host || !points.length) return;
  const W = 356, H = 110, pad = { l: 30, r: 6, t: 8, b: 16 };
  const xs = points.map((p) => p.d);
  const zs = points.map((p) => p.z);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const z0 = Math.min(...zs), z1 = Math.max(...zs);
  const sx = (d: number) => pad.l + ((d - x0) / (x1 - x0 || 1)) * (W - pad.l - pad.r);
  const sy = (z: number) => pad.t + (1 - (z - z0) / (z1 - z0 || 1)) * (H - pad.t - pad.b);

  const line = (pts: typeof points) =>
    pts.map((p, i) => `${i ? 'L' : 'M'}${sx(p.d).toFixed(1)},${sy(p.z).toFixed(1)}`).join('');
  const inside = points.filter((p) => p.inside);

  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img"
      aria-label="Elevation profile of the reach">
    <path d="${line(points)}" fill="none" stroke="#4a5b6b" stroke-width="2"
      stroke-linecap="round" stroke-linejoin="round"/>
    <path d="${line(inside)}" fill="none" stroke="#e8912b" stroke-width="2.5"
      stroke-linecap="round" stroke-linejoin="round"/>
    <text x="2" y="${sy(z1) + 4}" fill="#8fa3b5" font-size="9">${z1.toFixed(0)}m</text>
    <text x="2" y="${sy(z0) + 4}" fill="#8fa3b5" font-size="9">${z0.toFixed(0)}m</text>
    <text x="${sx(inside[0]?.d ?? 0)}" y="${H - 4}" fill="#8fa3b5" font-size="9">top</text>
    <text x="${sx(inside[inside.length - 1]?.d ?? 0) - 18}" y="${H - 4}"
      fill="#8fa3b5" font-size="9">bottom</text>
  </svg>`;
}

/* ---------- session persistence ---------- */

/** The filter panel, by element id. Checkboxes save as 'true'/'false'. */
const FILTER_IDS = [
  'minGrad', 'maxGrad', 'minLen', 'maxLen', 'minDrain', 'maxDrain',
  'minConf', 'minAlt', 'sort', 'viewOnly', 'hideLogged', 'showKnown', 'basemap',
];

function saveFilters() {
  const filters: Record<string, string> = {};
  for (const id of FILTER_IDS) {
    const node = document.getElementById(id);
    if (node instanceof HTMLInputElement && node.type === 'checkbox') {
      filters[id] = String(node.checked);
    } else if (node instanceof HTMLInputElement || node instanceof HTMLSelectElement) {
      filters[id] = node.value;
    }
  }
  saveState({ filters });
}

/** Put the saved filter panel back. The preset select shows the matching
 *  preset, or 'custom' when the sliders were moved off it. A fresh visit has
 *  nothing saved: the HTML defaults and the preset select apply as before. */
function restoreFilters() {
  if (!saved.filters) return;
  for (const [id, value] of Object.entries(saved.filters)) {
    const node = document.getElementById(id);
    if (node instanceof HTMLInputElement && node.type === 'checkbox') {
      node.checked = value === 'true';
    } else if (node instanceof HTMLInputElement || node instanceof HTMLSelectElement) {
      node.value = value;
    }
  }
  el<HTMLSelectElement>('preset').value = presetFor(saved.filters) ?? 'custom';
}

/** Re-select the saved watercourse once the rows for it exist. Best effort:
 *  if the restored filters no longer return it, it stays unselected. */
function tryRestoreSelection() {
  const sel = pendingSelection;
  if (!sel) return;
  // The map's load can beat the worker's first results, and boot() can still
  // be fetching known.json: keep the selection pending until there is
  // something to select into, or it is silently dropped. A known canyon needs
  // both — its list highlight lands on a group row.
  if (!rows.length || (sel.kind === 'known' && !known.length)) return;
  pendingSelection = null;
  if (sel.kind === 'reach') {
    selectCandidate(sel.id);
  } else if (sel.kind === 'group') {
    const at = rows.findIndex((r) => !r.cand && r.group.key === sel.id);
    if (at >= 0) select(at);
  } else {
    const idx = known.findIndex((k) => `${k.chain}:${k.i}:${k.j}` === sel.id);
    if (idx >= 0) selectKnown(idx);
  }
}

/* ---------- wiring ---------- */

let debounce: number | undefined;
document.querySelectorAll('input[type=range]').forEach((input) => {
  input.addEventListener('input', () => {
    el<HTMLSelectElement>('preset').value = 'custom';
    readQuery();
    clearTimeout(debounce);
    debounce = setTimeout(() => { saveFilters(); run(); }, 60) as unknown as number;
  });
});
el('sort').addEventListener('change', () => { saveFilters(); renderResults(); });
el('viewOnly').addEventListener('change', () => { saveFilters(); renderResults(); });
el('hideLogged').addEventListener('change', () => { saveFilters(); renderResults(); });
el('showKnown').addEventListener('change', (e) => {
  saveFilters();
  const on = (e.target as HTMLInputElement).checked ? 'visible' : 'none';
  for (const id of ['known', 'known-casing', 'known-dots']) {
    map.setLayoutProperty(id, 'visibility', on);
  }
});
el('basemap').addEventListener('change', (e) => {
  saveFilters();
  const key = (e.target as HTMLSelectElement).value;
  for (const k of Object.keys(BASEMAPS)) {
    map.setLayoutProperty(`base-${k}`, 'visibility', k === key ? 'visible' : 'none');
  }
});

el('preset').addEventListener('change', (e) => {
  applyPreset((e.target as HTMLSelectElement).value);
  saveFilters();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const next = selected + (e.key === 'ArrowDown' ? 1 : -1);
    if (next >= 0 && next < rows.length) {
      select(next);
      e.preventDefault();
    }
  }
});

restoreFilters();
boot();
