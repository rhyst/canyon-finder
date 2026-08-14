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
  buildGroups, buildRows, candId, findRow, groupOf, groupScore, nearestLogged,
  type Group, type GroupModel, type Row,
} from './grouping';
import { covered, isDud, isGraded } from './canyonlog';
import { fmtArea, reachLine, watercourseLine } from './format';

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });

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
  center: [-4.6, 56.9],
  zoom: 6.4,
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
      layout: { visibility: k === 'topo' ? ('visible' as const) : ('none' as const) },
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
let results: Candidate[] = []; // everything the worker returned
let view: Candidate[] = []; // filtered + sorted
let rows: Row[] = []; // exactly what the list shows: group headers plus expanded reaches
let selected = -1; // index into `rows`
let stats = { scanned: 0, ms: 0, totalGroups: 0, totalReaches: 0, truncated: false };
let queryId = 0;
let ready = false;

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
      if (hit !== undefined) selectCandidate(String(hit), id === 'reach-dots');
    });
    map.on('mouseenter', id, () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', id, () => (map.getCanvas().style.cursor = ''));
  }
  map.on('click', 'known', (e: MapLayerMouseEvent) => {
    const idx = e.features?.[0]?.properties?.idx;
    if (idx !== undefined) selectKnown(Number(idx), false);
  });
  map.on('click', 'known-dots', (e: MapLayerMouseEvent) => {
    const idx = e.features?.[0]?.properties?.idx;
    if (idx !== undefined) selectKnown(Number(idx), true);
  });
  for (const id of ['known', 'known-dots']) {
    map.on('mouseenter', id, () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', id, () => (map.getCanvas().style.cursor = ''));
  }
  map.on('moveend', () => {
    if (el<HTMLInputElement>('viewOnly').checked) renderResults();
  });
  if (results.length) renderResults(); // the worker may have finished first
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
  scoreModel = score;
  groupModel = groups;
  payload = meta;
  known = (knownDoc.canyons as KnownCanyon[]).map((k) => ({
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
  worker.postMessage({ type: 'init', meta, bin, score, groupModel: groups }, [bin]);
}

worker.onmessage = (e: MessageEvent) => {
  const msg = e.data;
  if (msg.type === 'ready') {
    ready = true;
    applyPreset(el<HTMLSelectElement>('preset').value);
  } else if (msg.type === 'results') {
    if (msg.id !== queryId) return;
    results = msg.candidates;
    stats = {
      scanned: msg.scanned, ms: msg.ms, totalGroups: msg.totalGroups,
      totalReaches: msg.totalReaches, truncated: msg.truncated,
    };
    renderResults();
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
  for (const g of groups) {
    promise.set(g.key, groupScore(g, groupModel));
    nearby.set(g.key, nearestLogged(g, known));
  }
  if (el<HTMLInputElement>('hideLogged').checked) {
    groups = groups.filter((g) => (nearby.get(g.key) ?? Infinity) > LOGGED_RADIUS);
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
      `logged descents</span>` : '');

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
        : ''}${(nearby.get(group.key) ?? Infinity) <= LOGGED_RADIUS ? '<span class="tag mini">logged</span> · ' : ''}${multi
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
    select(i, true);
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
function selectCandidate(id: string, fly: boolean) {
  const target = view.find((c) => candId(c) === id);
  if (!target) return;
  const key = groupOf(target);
  const group = rows.find((r) => r.group.key === key)?.group;
  if (group && group.members.length > 1 && !expanded.has(key)) {
    expanded.add(key);
    renderResults(true);
  }
  const at = findRow(rows, id);
  if (at >= 0) select(at, fly);
}

function contextOf(group: Group) {
  return {
    promise: groupModel ? (promise.get(group.key) ?? 0) : null,
    logged: (nearby.get(group.key) ?? Infinity) <= LOGGED_RADIUS,
  };
}

function select(idx: number, fly: boolean) {
  const row = rows[idx];
  if (!row) return;
  selected = idx;
  const { group, cand } = row;

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
    }, fly);
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
    }, fly);
  }

  ensureRendered(idx);
  const items = el<HTMLUListElement>('results').children;
  for (let k = 0; k < items.length; k++) {
    items[k].setAttribute('aria-selected', String(k === idx));
  }
  items[idx]?.scrollIntoView({ block: 'nearest' });
}

function selectKnown(idx: number, fly: boolean) {
  const k = known[idx];
  if (!k) return;
  selected = -1;
  const grade = k.grade ? `${k.grade} · ` : '';
  const dud = isDud(k);
  showDetail({
    coords: [k.coords],
    title: `${k.name} <span class="tag${dud ? ' dud' : ''}">` +
      `${dud ? '0 stars' : 'logged'}</span>`,
    stats: `${grade}${dud ? 'visited, reported not worth it' : k.category || 'ungraded'}` +
      ` · measured ` +
      `${(k.gradient * 100).toFixed(1)}% over ${k.length.toFixed(0)} m ` +
      `(${k.drop.toFixed(0)} m) on ${k.watercourse || 'an unnamed burn'}`,
    chain: k.chain,
    i: k.i,
    j: k.j,
    extra: k.url
      ? `<a target="_blank" rel="noreferrer" href="${k.url}">Canyon Log</a>`
      : '',
  }, fly);
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

function showDetail(info: Detail, fly: boolean) {
  (map.getSource('picked') as GeoJSONSource | undefined)?.setData({
    type: 'Feature',
    geometry: { type: 'MultiLineString', coordinates: info.coords },
    properties: {},
  } as never);

  const flat = info.coords.flat();
  const lons = flat.map((p) => p[0]);
  const lats = flat.map((p) => p[1]);
  if (fly) {
    map.fitBounds(
      [
        [Math.min(...lons), Math.min(...lats)],
        [Math.max(...lons), Math.max(...lats)],
      ],
      { padding: 120, maxZoom: 15, duration: 600 },
    );
  }

  const lat = lats[0];
  const lon = lons[0];
  const d = el('detail');
  d.hidden = false;
  d.innerHTML = `
    <button aria-label="Close">×</button>
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
  d.querySelector('button')!.onclick = () => (d.hidden = true);
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

/* ---------- wiring ---------- */

let debounce: number | undefined;
document.querySelectorAll('input[type=range]').forEach((input) => {
  input.addEventListener('input', () => {
    el<HTMLSelectElement>('preset').value = 'custom';
    readQuery();
    clearTimeout(debounce);
    debounce = setTimeout(run, 60) as unknown as number;
  });
});
el('sort').addEventListener('change', () => renderResults());
el('viewOnly').addEventListener('change', () => renderResults());
el('hideLogged').addEventListener('change', () => renderResults());
el('showKnown').addEventListener('change', (e) => {
  const on = (e.target as HTMLInputElement).checked ? 'visible' : 'none';
  for (const id of ['known', 'known-casing', 'known-dots']) {
    map.setLayoutProperty(id, 'visibility', on);
  }
});
el('basemap').addEventListener('change', (e) => {
  const key = (e.target as HTMLSelectElement).value;
  for (const k of Object.keys(BASEMAPS)) {
    map.setLayoutProperty(`base-${k}`, 'visibility', k === key ? 'visible' : 'none');
  }
});

el('preset').addEventListener('change', (e) => {
  applyPreset((e.target as HTMLSelectElement).value);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const next = selected + (e.key === 'ArrowDown' ? 1 : -1);
    if (next >= 0 && next < rows.length) {
      select(next, true);
      e.preventDefault();
    }
  }
});

boot();
