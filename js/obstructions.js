// Mapped-feature analysis from OpenStreetMap via the Overpass API.
// OSM building outlines are often complete in the UK, but heights are usually missing,
// trees are patchy, and chimneys, aerials and hedges are almost never mapped.
// Results are therefore "things worth looking at", never proof of a clear view.

import { localOffsetMetres, isBearingInSector, toDeg, pointInPolygon, normaliseBearing } from './geo.js';

export const DEFAULT_OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const METRES_PER_LEVEL = 3.0; // planning assumption for building:levels → height, labelled as such

export function buildOverpassQuery(lat, lon, radius = 120) {
  const r = Math.round(radius);
  return `[out:json][timeout:25];
(
  way["building"](around:${r},${lat},${lon});
  relation["building"](around:${r},${lat},${lon});
  node["natural"="tree"](around:${r},${lat},${lon});
  way["natural"~"^(tree_row|wood)$"](around:${r},${lat},${lon});
  way["landuse"="forest"](around:${r},${lat},${lon});
  node["man_made"~"^(mast|tower|chimney)$"](around:${r},${lat},${lon});
);
out geom tags;`;
}

// Tried in order when the main server is busy, slow or down. Public servers are often
// overloaded at peak times, so a second one makes a result far more likely.
export const FALLBACK_OVERPASS_URLS = ['https://overpass.private.coffee/api/interpreter'];
const OVERPASS_TIMEOUT_MS = 30000; // per server; the query itself asks for at most 25 s

export async function fetchMappedFeatures(lat, lon, { fetchImpl = globalThis.fetch?.bind(globalThis), url = DEFAULT_OVERPASS_URL, fallbackUrls = FALLBACK_OVERPASS_URLS, radius = 120, timeoutMs = OVERPASS_TIMEOUT_MS } = {}) {
  const urls = [...new Set([url, ...fallbackUrls].filter(Boolean))];
  const body = `data=${encodeURIComponent(buildOverpassQuery(lat, lon, radius))}`;
  let lastError;
  for (const u of urls) {
    try {
      return parseOverpass(await requestOverpass(fetchImpl, u, body, timeoutMs));
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

async function requestOverpass(fetchImpl, url, body, timeoutMs) {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: ctrl?.signal,
      });
    } catch (err) {
      if (err?.name === 'AbortError') { const e = new Error('The map-feature service took too long to answer. Try again in a minute.'); e.code = 'timeout'; e.cause = err; throw e; }
      const e = new Error('Could not reach the map-feature service. Buildings and trees are not shown.'); e.code = 'network'; e.cause = err; throw e;
    }
    // 502/503 are what an overloaded Overpass server or its proxy returns, so treat them like 429/504.
    if ([429, 502, 503, 504].includes(res.status)) { const e = new Error('The map-feature service is busy. Try again in a minute.'); e.code = 'rate-limited'; throw e; }
    if (!res.ok) { const e = new Error(`The map-feature service returned an error (${res.status}).`); e.code = 'bad-response'; throw e; }
    try { return await res.json(); } catch (err) {
      if (err?.name === 'AbortError') { const e = new Error('The map-feature service took too long to answer. Try again in a minute.'); e.code = 'timeout'; e.cause = err; throw e; }
      const e = new Error('The map-feature service sent an unreadable response.'); e.code = 'bad-response'; e.cause = err; throw e;
    }
  } finally { if (timer) clearTimeout(timer); }
}

/** Overpass JSON → [{id, kind, name, geometry:[{lat,lon}], height:{metres, source}|null}] */
export function parseOverpass(body) {
  const out = [];
  for (const el of body?.elements ?? []) {
    const t = el.tags ?? {};
    let kind;
    if (t.building) kind = 'building';
    else if (t.natural === 'tree') kind = 'tree';
    else if (t.natural === 'tree_row') kind = 'tree-row';
    else if (t.natural === 'wood' || t.landuse === 'forest') kind = 'woodland';
    else if (t.man_made) kind = t.man_made;
    else continue;

    let geometry = [];
    if (el.type === 'node') geometry = [{ lat: el.lat, lon: el.lon }];
    else if (Array.isArray(el.geometry)) geometry = el.geometry.map((g) => ({ lat: g.lat, lon: g.lon }));
    else if (Array.isArray(el.members)) {
      const outer = el.members.find((m) => m.role === 'outer' && Array.isArray(m.geometry));
      if (outer) geometry = outer.geometry.map((g) => ({ lat: g.lat, lon: g.lon }));
    }
    if (!geometry.length) continue;
    out.push({ id: `${el.type}/${el.id}`, kind, name: t.name ?? null, geometry, height: parseHeight(t) });
  }
  return out;
}

export function parseHeight(tags) {
  const h = parseMetres(tags.height) ?? parseMetres(tags['est_height']);
  if (h != null) return { metres: h, source: 'mapped height tag' };
  const levels = Number.parseFloat(tags['building:levels']);
  if (Number.isFinite(levels) && levels > 0) {
    const roof = Number.parseFloat(tags['roof:levels']);
    const total = levels + (Number.isFinite(roof) ? roof : 0);
    return { metres: total * METRES_PER_LEVEL + 1, source: `estimated from ${total} storey(s) × ${METRES_PER_LEVEL} m` };
  }
  return null;
}

function parseMetres(v) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  const ft = s.match(/^([\d.]+)\s*(ft|')$/);
  if (ft) return Number.parseFloat(ft[1]) * 0.3048;
  const m = s.match(/^([\d.]+)\s*m?$/);
  return m ? Number.parseFloat(m[1]) : null;
}

/**
 * For each feature: nearest distance/bearing, whether it falls in the alignment or
 * clearance band, and the elevation angle its top makes from an assumed mount height.
 */
export function analyseFeatures(features, property, direction, { mountHeight = 5, concernElevation = 25, maxDistance = 120 } = {}) {
  const hasSector = direction?.status === 'estimate';
  const results = [];
  let ownBuilding = null;

  for (const f of features) {
    if (f.kind === 'building' && f.geometry.length > 2 && pointInPolygon(property.lat, property.lon, f.geometry)) {
      ownBuilding = { ...f };
      continue;
    }
    const pts = densify(f.geometry, property);
    let nearest = null, nearestInAlign = null, nearestInClear = null;
    for (const p of pts) {
      if (p.d < 0.5) continue;
      if (!nearest || p.d < nearest.d) nearest = p;
      if (hasSector) {
        if (isBearingInSector(p.b, direction.centreAzimuth, direction.alignment.halfWidth) && (!nearestInAlign || p.d < nearestInAlign.d)) nearestInAlign = p;
        if (isBearingInSector(p.b, direction.centreAzimuth, direction.clearance.halfWidth) && (!nearestInClear || p.d < nearestInClear.d)) nearestInClear = p;
      }
    }
    if (!nearest || nearest.d > maxDistance) continue;
    const ref = nearestInAlign ?? nearestInClear ?? nearest;
    const zone = nearestInAlign ? 'alignment' : nearestInClear ? 'clearance' : 'outside';
    const elevation = f.height ? toDeg(Math.atan2(f.height.metres - mountHeight, ref.d)) : null;
    let concern = 'none';
    if (zone !== 'outside') {
      if (elevation == null) concern = (f.kind === 'tree' || f.kind === 'tree-row' || f.kind === 'woodland' || ref.d < 25) ? 'check' : 'low';
      else concern = elevation >= concernElevation ? 'high' : elevation >= concernElevation * 0.6 ? 'check' : 'low';
    }
    results.push({ ...f, distance: ref.d, bearing: ref.b, zone, elevation, concern });
  }

  const rank = { high: 0, check: 1, low: 2, none: 3 };
  results.sort((a, b) => rank[a.concern] - rank[b.concern] || a.distance - b.distance);
  return {
    ownBuilding,
    features: results,
    summary: {
      total: results.length,
      inAlignment: results.filter((r) => r.zone === 'alignment').length,
      inClearance: results.filter((r) => r.zone !== 'outside').length,
      high: results.filter((r) => r.concern === 'high').length,
      check: results.filter((r) => r.concern === 'check').length,
      unknownHeightInSector: results.filter((r) => r.zone !== 'outside' && r.elevation == null).length,
    },
    assumptions: { mountHeight, concernElevation, metresPerLevel: METRES_PER_LEVEL },
  };
}

// Vertices plus points along each edge every ~2 m so long walls are measured correctly.
function densify(geometry, origin) {
  const toLocal = (g) => {
    const o = localOffsetMetres(origin.lat, origin.lon, g.lat, g.lon);
    return { ...o, d: Math.hypot(o.x, o.y), b: normaliseBearing(toDeg(Math.atan2(o.x, o.y))) };
  };
  const local = geometry.map(toLocal);
  if (local.length < 2) return local;
  const pts = [];
  for (let i = 0; i < local.length - 1; i++) {
    const a = local[i], b = local[i + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 2));
    for (let k = 0; k < n; k++) {
      const x = a.x + ((b.x - a.x) * k) / n, y = a.y + ((b.y - a.y) * k) / n;
      pts.push({ x, y, d: Math.hypot(x, y), b: normaliseBearing(toDeg(Math.atan2(x, y))) });
    }
  }
  pts.push(local[local.length - 1]);
  return pts;
}
