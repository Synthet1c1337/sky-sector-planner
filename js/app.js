// App controller: wires the map, search, direction model, assessment and job storage.
/* global L */

import { normalisePostcode, postcodeProblem } from './postcode.js';
import { GeocodingService, PostcodesIoProvider, NominatimProvider } from './geocoding.js';
import {
  estimateDirection, UK_NORTHERN_SKY_PROFILE, LOCATION_ACCURACY, locationAccuracyLabel,
  isPreciseLocation, summariseNearbyObservedBearings, trueToMagnetic,
} from './direction.js';
import { sectorPolygon, destinationPoint, formatBearing, compassPoint, normaliseBearing, angularDifference, toRad } from './geo.js';
import { fetchMappedFeatures, analyseFeatures, DEFAULT_OVERPASS_URL } from './obstructions.js';
import { buildAssessment } from './assessment.js';
import { JobRepository, createJob, safeLocalStorage, loadSettings, saveSettings, DEFAULT_SETTINGS, JOB_STATUSES } from './store.js';
import { buildReport } from './report.js';
import * as photos from './photos.js';

// ---------- services ----------
const { storage, persistent } = safeLocalStorage();
let settings = loadSettings(storage);
const repo = new JobRepository(storage);

function makeGeocoder() {
  return new GeocodingService({
    postcodeProvider: new PostcodesIoProvider(),
    addressProvider: new NominatimProvider({ email: settings.nominatimEmail }),
  });
}
let geocoder = makeGeocoder();

// ---------- state ----------
const state = {
  location: null,      // { lat, lon, accuracy, source, label, postcode }
  direction: estimateDirection(null),
  features: null,      // parsed OSM features (raw)
  analysis: null,
  featureStatus: 'idle', // idle | loading | loaded | error
  featureError: '',
  mounts: [],          // { id, label, lat, lon }
  jobId: null,
  mode: 'none',        // none | place | mount
  tab: 'sector',
  jobFilter: 'all',
  openJobId: null,
  heading: null,       // live device heading (true), when enabled
  results: null,
};

// ---------- helpers ----------
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ICON = {
  info: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 8h.01M11 12h1v4h1"></path></svg>',
  warn: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2 20h20L12 3z"></path><path d="M12 10v4M12 17h.01"></path></svg>',
  x: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"></path></svg>',
};
const notice = (kind, html) => `<div class="notice notice-${kind}">${kind === 'info' ? ICON.info : ICON.warn}<p>${html}</p></div>`;
const isPhone = () => window.matchMedia('(max-width: 820px)').matches;

let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

function directionOverrides() {
  return { alignmentHalfWidth: settings.alignmentHalfWidth ?? undefined, clearanceHalfWidth: settings.clearanceHalfWidth ?? undefined };
}

// ---------- map ----------
const map = L.map('map', { zoomControl: true, attributionControl: true, worldCopyJump: true, tap: true }).setView([54.5, -3.2], 6);
map.zoomControl.setPosition('bottomright');

const baseLayers = {
  osm: () => L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 20, maxNativeZoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
  }),
  satellite: () => L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 20, maxNativeZoom: 19,
    attribution: 'Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community',
  }),
  custom: () => L.tileLayer(settings.customTileUrl, { maxZoom: 20, maxNativeZoom: 19, attribution: esc(settings.customTileAttribution || 'Custom tiles') }),
};
let baseLayer = null;
function setBaseLayer(id) {
  if (id === 'custom' && !settings.customTileUrl) id = 'osm';
  if (baseLayer) map.removeLayer(baseLayer);
  baseLayer = baseLayers[id]().addTo(map);
  baseLayer.on('tileerror', onTileError);
  settings.baseLayer = id; persistSettings();
  $('#layer-label').textContent = id === 'satellite' ? 'Map' : 'Satellite';
}
let tileErrorShown = false;
function onTileError() {
  if (tileErrorShown) return; tileErrorShown = true;
  if (!navigator.onLine) toast('Offline: map tiles cannot load. Saved jobs still work.');
}

const layers = {
  clearance: L.layerGroup().addTo(map),
  sector: L.layerGroup().addTo(map),
  features: L.layerGroup().addTo(map),
  mounts: L.layerGroup().addTo(map),
  property: L.layerGroup().addTo(map),
  me: L.layerGroup().addTo(map),
};

const propIcon = (approx) => L.divIcon({ className: '', html: `<div class="pin-prop${approx ? ' is-approx' : ''}"></div>`, iconSize: [26, 26], iconAnchor: [13, 13] });
const mountIcon = (n) => L.divIcon({ className: '', html: `<div class="pin-mount">M${n}</div>`, iconSize: [30, 30], iconAnchor: [15, 15] });

function focusMap(lat, lon, zoom) {
  map.setView([lat, lon], zoom, { animate: false });
  if (isPhone()) {
    const sheet = $('#panel').getBoundingClientRect().height;
    map.panBy([0, Math.round(sheet / 2)], { animate: false });
  }
}

function drawAll() {
  for (const g of Object.values(layers)) if (g !== layers.me) g.clearLayers();
  const loc = state.location;
  if (!loc) return;
  const d = state.direction;

  if (d.status === 'estimate') {
    const ring = (hw, r) => sectorPolygon(loc.lat, loc.lon, d.centreAzimuth, hw, r).map((p) => [p.lat, p.lon]);
    L.polygon(ring(d.clearance.halfWidth, 70), { color: '#4C8DFF', weight: 1.5, dashArray: '6 6', fillColor: '#4C8DFF', fillOpacity: 0.12, interactive: false }).addTo(layers.clearance);
    L.polygon(ring(d.alignment.halfWidth, 70), { color: '#2EC5E6', weight: 2, fillColor: '#2EC5E6', fillOpacity: 0.32, interactive: false }).addTo(layers.sector);
    const tip = destinationPoint(loc.lat, loc.lon, d.centreAzimuth, 78);
    L.marker([tip.lat, tip.lon], { opacity: 0, interactive: false, keyboard: false })
      .bindTooltip(`${formatBearing(d.alignment.from)}–${formatBearing(d.alignment.to)} · likely sky`, { permanent: true, direction: 'top', className: 'sector-label' })
      .addTo(layers.sector);
    if (d.geoArc) {
      const g1 = destinationPoint(loc.lat, loc.lon, d.geoArc.azimuth, 12);
      const g2 = destinationPoint(loc.lat, loc.lon, d.geoArc.azimuth, 45);
      L.polyline([[g1.lat, g1.lon], [g2.lat, g2.lon]], { color: '#F2B544', weight: 3, dashArray: '4 6', interactive: false }).addTo(layers.sector);
      L.marker([g2.lat, g2.lon], { opacity: 0, interactive: false, keyboard: false })
        .bindTooltip(`GEO arc, ${d.geoArc.peakElevation.toFixed(0)}° up (avoided)`, { permanent: true, direction: 'bottom', className: 'sector-label geo-label' })
        .addTo(layers.sector);
    }
  }

  const approx = !isPreciseLocation(loc.accuracy);
  if (loc.accuracy === LOCATION_ACCURACY.POSTCODE) {
    L.circle([loc.lat, loc.lon], { radius: 100, color: '#F2B544', weight: 1.5, dashArray: '4 6', fill: false, interactive: false }).addTo(layers.property);
  }
  const m = L.marker([loc.lat, loc.lon], { icon: propIcon(approx), draggable: true, title: 'Property (drag onto the roof)', keyboard: true, zIndexOffset: 1000 }).addTo(layers.property);
  m.on('dragend', () => { const p = m.getLatLng(); placeProperty(p.lat, p.lng); });

  state.mounts.forEach((mt, i) => {
    const mk = L.marker([mt.lat, mt.lon], { icon: mountIcon(i + 1), draggable: true, title: `Mount M${i + 1}` }).addTo(layers.mounts);
    mk.on('dragend', () => { const p = mk.getLatLng(); mt.lat = p.lat; mt.lon = p.lng; renderAssessment(); });
    mk.bindPopup(() => `<strong>M${i + 1}</strong> ${esc(mt.label || '')}<br><span class="mono">${mt.lat.toFixed(6)}, ${mt.lon.toFixed(6)}</span>`);
  });

  drawFeatures();
}

function drawFeatures() {
  layers.features.clearLayers();
  if (!state.analysis) return;
  const style = (f) => {
    if (f.concern === 'high') return { color: '#F2B544', weight: 2.5, fillColor: '#F2B544', fillOpacity: 0.45 };
    if (f.concern === 'check') return { color: '#F2B544', weight: 1.5, dashArray: '3 4', fillColor: '#F2B544', fillOpacity: 0.2 };
    return { color: '#9FB0CC', weight: 1, fillColor: '#C3D0E4', fillOpacity: 0.15 };
  };
  const popup = (f) => {
    const h = f.height ? `${f.height.metres.toFixed(1)} m (${esc(f.height.source)})` : 'height not mapped';
    const el = f.elevation == null ? '' : `<br>Top ≈ ${Math.max(0, Math.round(f.elevation))}° above a ${settings.mountHeight} m mount`;
    return `<strong>${esc(f.name || f.kind)}</strong><br>${Math.round(f.distance)} m at ${formatBearing(f.bearing)} ${compassPoint(f.bearing)}<br>${h}${el}`;
  };
  for (const f of state.analysis.features) {
    const pts = f.geometry.map((g) => [g.lat, g.lon]);
    let layer;
    if (pts.length === 1) layer = L.circleMarker(pts[0], { radius: f.kind === 'tree' ? 6 : 5, ...style(f), fillOpacity: 0.6, color: f.concern === 'none' || f.concern === 'low' ? '#6BDB9A' : '#F2B544' });
    else if (f.kind === 'tree-row') layer = L.polyline(pts, { ...style(f), weight: 4 });
    else layer = L.polygon(pts, style(f));
    layer.bindPopup(popup(f)).addTo(layers.features);
  }
  const own = state.analysis.ownBuilding;
  if (own) L.polygon(own.geometry.map((g) => [g.lat, g.lon]), { color: '#2EC5E6', weight: 2, fill: false, interactive: false }).addTo(layers.features);
}

// ---------- location changes ----------
function setLocation(loc, { fit = true } = {}) {
  state.location = loc;
  state.direction = estimateDirection(loc, UK_NORTHERN_SKY_PROFILE, directionOverrides());
  state.analysis = state.features ? analyseFeatures(state.features, loc, state.direction, analysisOptions()) : null;
  if (fit) focusMap(loc.lat, loc.lon, loc.accuracy === LOCATION_ACCURACY.POSTCODE ? 17 : 18);
  drawAll();
  renderAll();
}

function placeProperty(lat, lon) {
  const prev = state.location ?? {};
  setLocation({ ...prev, lat, lon, accuracy: LOCATION_ACCURACY.INSTALLER, source: 'Placed on map by installer', label: prev.label ?? 'Pinned property' }, { fit: false });
  if (state.featureStatus === 'loaded' && state.features) {
    // Re-measure from the new pin; refetch only if it has moved far from the loaded area.
    if (state.featureOrigin && L.latLng(lat, lon).distanceTo(L.latLng(state.featureOrigin.lat, state.featureOrigin.lon)) > 60) loadFeatures();
  }
}

function analysisOptions() {
  return { mountHeight: Number(settings.mountHeight) || 5, concernElevation: Number(settings.concernElevation) || 25 };
}

// ---------- search ----------
$('#search-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('#q').value.trim();
  const house = $('#house').value.trim();
  const msg = $('#search-msg');
  msg.className = 'field-msg'; msg.textContent = '';
  const looksPostcode = /^[A-Za-z]{1,2}\d/.test(q) && q.replace(/\s/g, '').length <= 7;
  if (looksPostcode && !normalisePostcode(q)) {
    msg.className = 'field-msg is-error'; msg.textContent = postcodeProblem(q); $('#q').focus(); return;
  }
  if (!q) { msg.className = 'field-msg is-error'; msg.textContent = 'Enter a postcode or an address.'; return; }
  const btn = $('#search-btn');
  btn.disabled = true; btn.innerHTML = '<span class="spinner" aria-hidden="true"></span>';
  msg.textContent = 'Searching…';
  try {
    const { results, warnings } = await geocoder.search(q, { houseNameOrNumber: house });
    const pc = normalisePostcode(q);
    if (pc) $('#q').value = pc;
    msg.className = 'field-msg is-ok';
    msg.textContent = `${results.length} match${results.length === 1 ? '' : 'es'}. Pick the customer's property.`;
    state.results = { results, warnings };
    renderResults();
    if (results.length === 1) chooseResult(0);
  } catch (err) {
    msg.className = 'field-msg is-error';
    msg.textContent = err.message || 'Search failed.';
    state.results = null; renderResults();
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.5-3.5"></path></svg>';
  }
});

function accuracyChip(acc) {
  const cls = acc === LOCATION_ACCURACY.INSTALLER || acc === LOCATION_ACCURACY.ADDRESS ? 'chip-ok' : 'chip-warn';
  return `<span class="chip ${cls}">${esc(locationAccuracyLabel(acc))}</span>`;
}

function renderResults() {
  const box = $('#results');
  const r = state.results;
  if (!r) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = `<h2>Select the property</h2>
    ${r.warnings.map((w) => notice('warn', esc(w))).join('')}
    ${r.results.map((x, i) => `<button type="button" class="result" data-i="${i}">
        <span class="result-title">${esc(x.label)}</span>
        <span class="result-meta">${accuracyChip(x.accuracy)}<span>${esc(x.source)}</span></span>
      </button>`).join('')}`;
  box.querySelectorAll('.result').forEach((b) => b.addEventListener('click', () => chooseResult(Number(b.dataset.i))));
}

function chooseResult(i) {
  const x = state.results.results[i];
  state.features = null; state.analysis = null; state.featureStatus = 'idle'; state.mounts = []; state.jobId = null;
  setLocation({ lat: x.lat, lon: x.lon, accuracy: x.accuracy, source: x.source, label: x.label, postcode: x.postcode ?? normalisePostcode($('#q').value) ?? '', attribution: x.attribution });
  state.results = null; renderResults();
  if (!isPreciseLocation(x.accuracy)) setMode('place');
  else setMode('none');
}

// ---------- modes ----------
function setMode(mode) {
  state.mode = state.mode === mode ? 'none' : mode;
  $('#mode-place').setAttribute('aria-pressed', String(state.mode === 'place'));
  $('#mode-mount').setAttribute('aria-pressed', String(state.mode === 'mount'));
  const hint = $('#mode-hint');
  hint.hidden = state.mode === 'none';
  hint.textContent = state.mode === 'place' ? 'Tap the customer’s roof to place the pin' : state.mode === 'mount' ? 'Tap to add a candidate mount' : '';
  map.getContainer().style.cursor = state.mode === 'none' ? '' : 'crosshair';
}
$('#mode-place').addEventListener('click', () => setMode('place'));
$('#mode-mount').addEventListener('click', () => {
  if (!state.location) { toast('Find the property first.'); return; }
  setMode('mount');
});
map.on('click', (e) => {
  if (state.mode === 'place') {
    if (!state.location) state.location = { label: 'Pinned property', postcode: '' };
    placeProperty(e.latlng.lat, e.latlng.lng);
    setMode('none');
    toast('Roof position set');
  } else if (state.mode === 'mount') {
    state.mounts.push({ id: `m${Date.now()}`, label: '', lat: e.latlng.lat, lon: e.latlng.lng });
    drawAll(); renderAssessment();
    toast(`Mount M${state.mounts.length} added`);
  }
});

$('#btn-layer').addEventListener('click', () => setBaseLayer(settings.baseLayer === 'satellite' ? 'osm' : 'satellite'));

$('#btn-locate').addEventListener('click', () => {
  if (!navigator.geolocation) { toast('Location is not available in this browser.'); return; }
  navigator.geolocation.getCurrentPosition((pos) => {
    layers.me.clearLayers();
    const { latitude: lat, longitude: lon, accuracy } = pos.coords;
    L.circle([lat, lon], { radius: accuracy, color: '#4C8DFF', weight: 1, fillOpacity: 0.08, interactive: false }).addTo(layers.me);
    L.marker([lat, lon], { icon: L.divIcon({ className: '', html: '<div class="pin-me"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), title: 'You' }).addTo(layers.me);
    focusMap(lat, lon, 18);
    toast(`Your position ±${Math.round(accuracy)} m`);
  }, (err) => toast(err.code === 1 ? 'Location permission denied. Allow it in your browser settings.' : 'Could not get your location.'), { enableHighAccuracy: true, timeout: 15000 });
});

// ---------- mapped features ----------
$('#btn-features').addEventListener('click', loadFeatures);
async function loadFeatures() {
  if (!state.location) { toast('Find the property first.'); return; }
  const btn = $('#btn-features');
  state.featureStatus = 'loading'; renderAssessment();
  btn.disabled = true;
  try {
    const { lat, lon } = state.location;
    state.features = await fetchMappedFeatures(lat, lon, { url: settings.overpassUrl || DEFAULT_OVERPASS_URL, radius: 140 });
    state.featureOrigin = { lat, lon };
    state.analysis = analyseFeatures(state.features, state.location, state.direction, analysisOptions());
    state.featureStatus = 'loaded';
    drawFeatures();
    toast(`${state.analysis.summary.total} mapped features nearby`);
  } catch (err) {
    state.featureStatus = 'error'; state.featureError = err.message;
  } finally {
    btn.disabled = false;
    renderAll();
  }
}

// ---------- rendering ----------
function renderAll() {
  renderLocationCard(); renderSector(); renderAssessment(); renderJobs(); updateJobsCount();
}

function renderLocationCard() {
  const c = $('#location-card'); const loc = state.location;
  if (!loc) { c.hidden = true; return; }
  c.hidden = false;
  const approx = !isPreciseLocation(loc.accuracy);
  c.innerHTML = `<h2>${esc(loc.label)}</h2>
    <dl class="kv">
      <dt>Lat, lon</dt><dd class="mono">${loc.lat.toFixed(6)}, ${loc.lon.toFixed(6)}</dd>
      <dt>Accuracy</dt><dd>${accuracyChip(loc.accuracy)}</dd>
      <dt>Source</dt><dd>${esc(loc.source)}</dd>
    </dl>
    ${approx ? notice('warn', loc.accuracy === LOCATION_ACCURACY.POSTCODE
      ? 'This is the postcode centre, not the customer’s roof. Tap <strong>Place roof</strong> and tap the roof on the map (satellite view helps).'
      : 'This match is not an exact address point. Place the pin on the roof before relying on nearby-feature checks.') : ''}`;
}

function wedge(cx, cy, r, from, to) {
  const p = (a) => [cx + r * Math.sin(toRad(a)), cy - r * Math.cos(toRad(a))];
  let span = normaliseBearing(to - from); if (span === 0) span = 360;
  const [x1, y1] = p(from), [x2, y2] = p(from + span);
  return `M${cx},${cy} L${x1.toFixed(2)},${y1.toFixed(2)} A${r},${r} 0 ${span > 180 ? 1 : 0} 1 ${x2.toFixed(2)},${y2.toFixed(2)} Z`;
}
function arc(cx, cy, r, from, to) {
  const p = (a) => [cx + r * Math.sin(toRad(a)), cy - r * Math.cos(toRad(a))];
  const span = normaliseBearing(to - from);
  const [x1, y1] = p(from), [x2, y2] = p(from + span);
  return `M${x1.toFixed(2)},${y1.toFixed(2)} A${r},${r} 0 ${span > 180 ? 1 : 0} 1 ${x2.toFixed(2)},${y2.toFixed(2)}`;
}

function compassSvg(d, observed) {
  const c = 84, r = 76;
  let ticks = '';
  for (let a = 0; a < 360; a += 10) {
    const major = a % 90 === 0; const len = major ? 10 : a % 30 === 0 ? 7 : 4;
    const s = Math.sin(toRad(a)), k = Math.cos(toRad(a));
    ticks += `<line class="tick${major ? ' tick-major' : ''}" x1="${(c + (r - len) * s).toFixed(1)}" y1="${(c - (r - len) * k).toFixed(1)}" x2="${(c + r * s).toFixed(1)}" y2="${(c - r * k).toFixed(1)}"></line>`;
  }
  const lbl = (a, t, cls = '') => `<text class="lbl ${cls}" x="${(c + (r - 22) * Math.sin(toRad(a))).toFixed(1)}" y="${(c - (r - 22) * Math.cos(toRad(a)) + 4).toFixed(1)}" text-anchor="middle">${t}</text>`;
  const geo = d.geoArc?.horizon ? `<path class="geo" d="${arc(c, c, r - 3, d.geoArc.horizon.east, d.geoArc.horizon.west)}"></path>` : '';
  const obs = observed?.mean != null ? `<line class="obs" x1="${c}" y1="${c}" x2="${(c + (r - 6) * Math.sin(toRad(observed.mean))).toFixed(1)}" y2="${(c - (r - 6) * Math.cos(toRad(observed.mean))).toFixed(1)}"></line>` : '';
  const hd = state.heading != null ? `<line class="heading" x1="${c}" y1="${c}" x2="${(c + (r - 30) * Math.sin(toRad(state.heading))).toFixed(1)}" y2="${(c - (r - 30) * Math.cos(toRad(state.heading))).toFixed(1)}"></line>` : '';
  return `<svg class="compass" viewBox="0 0 168 168" role="img" aria-label="Compass: likely sky sector ${formatBearing(d.alignment.from)} to ${formatBearing(d.alignment.to)}, geostationary arc to the south">
    <circle class="ring" cx="${c}" cy="${c}" r="${r}"></circle>
    <path class="clear" d="${wedge(c, c, r, d.clearance.from, d.clearance.to)}"></path>
    <path class="align" d="${wedge(c, c, r - 1, d.alignment.from, d.alignment.to)}"></path>
    ${geo}${ticks}${obs}${hd}
    ${lbl(0, 'N', 'lbl-n')}${lbl(90, 'E')}${lbl(180, 'S')}${lbl(270, 'W')}
    <circle cx="${c}" cy="${c}" r="3" fill="#F4F7FB" stroke="none"></circle>
  </svg>`;
}

function renderSector() {
  const v = $('#view-sector'); const d = state.direction;
  if (d.status !== 'estimate') {
    v.innerHTML = `${state.location ? `<div class="status-banner status-insufficient-data"><strong>Insufficient data</strong>${d.reasons.map((r) => `<p>${esc(r)}</p>`).join('')}</div>` : `<div class="empty"><strong>Find a property to begin</strong><span>Enter a UK postcode or address above, or tap <em>Place roof</em> and tap the map.</span></div>`}
      ${notice('info', 'This tool gives planning estimates only. The official Starlink app confirms obstructions and alignment.')}`;
    return;
  }
  const observed = summariseNearbyObservedBearings(repo.list().filter((j) => j.id !== state.jobId), state.location.lat, state.location.lon);
  const mag = trueToMagnetic(d.centreAzimuth, settings.declinationEast);
  const headingDelta = state.heading != null ? angularDifference(state.heading, d.centreAzimuth) : null;
  v.innerHTML = `
    <div class="sector-hero">
      ${compassSvg(d, observed)}
      <div class="readout">
        <span class="sub">Likely sky sector</span>
        <span class="big">${formatBearing(d.alignment.from)}<small>–</small>${formatBearing(d.alignment.to)}</span>
        <span class="sub">Centred near ${formatBearing(d.centreAzimuth)} ${d.centreCompass} (true)</span>
        <span><span class="chip chip-ok">Moderate · sky region</span> <span class="chip chip-warn">Low · exact bearing</span></span>
      </div>
    </div>
    <div class="stat-grid">
      <div class="stat"><span>Alignment band</span><strong>±${d.alignment.halfWidth}°</strong></div>
      <div class="stat"><span>Clearance band</span><strong>±${d.clearance.halfWidth}°</strong></div>
      <div class="stat"><span>GEO arc peak (south)</span><strong>${d.geoArc ? `${d.geoArc.peakElevation.toFixed(1)}°` : '—'}</strong></div>
      <div class="stat"><span>Centre, magnetic${Number(settings.declinationEast) ? '' : ' (set declination)'}</span><strong>${formatBearing(mag)}</strong></div>
    </div>
    ${observed.count ? notice('info', `Your recorded on-site bearings within ${observed.radiusKm} km: <strong class="mono">${formatBearing(observed.mean)}</strong> average from ${observed.count} job${observed.count === 1 ? '' : 's'} (spread ±${Math.round(observed.spread)}°). Shown in green on the compass.`) : ''}
    ${d.notes.map((n) => notice('warn', esc(n))).join('')}
    <div class="block">
      <h3>How this was estimated</h3>
      ${d.explanation.map((x) => `<p>${esc(x)}</p>`).join('')}
    </div>
    <div class="block">
      <h3>Phone compass</h3>
      ${state.heading == null
        ? `<p>Hold the phone flat and point its top edge to compare with the sector. Uses the magnetic compass with your declination setting.</p><div class="btn-row"><button type="button" class="btn" id="btn-compass">Start live compass</button></div>`
        : `<p>Phone heading <strong class="mono">${formatBearing(state.heading)}</strong> true. ${Math.abs(headingDelta) <= d.alignment.halfWidth ? 'Inside the likely sector.' : `Turn ${headingDelta > 0 ? 'right' : 'left'} about ${Math.round(Math.abs(headingDelta))}° to reach the sector centre.`}</p><div class="btn-row"><button type="button" class="btn-ghost" id="btn-compass-stop">Stop compass</button></div>`}
    </div>
    <details class="more">
      <summary>Evidence behind the model</summary>
      <div>
        <p>${esc(d.method)}</p>
        <ul class="basis">${UK_NORTHERN_SKY_PROFILE.basis.map((b) => `<li>${esc(b.claim)}<small>${esc(b.evidence)} Strength: ${esc(b.strength)}.</small></li>`).join('')}</ul>
        <p>Starlink does not publish a public API or dataset of per-location bearings, so none is used. Model ${esc(d.modelVersion)}, reviewed ${esc(UK_NORTHERN_SKY_PROFILE.lastReviewed)}.</p>
      </div>
    </details>
    ${notice('warn', esc(d.warning))}`;
  $('#btn-compass')?.addEventListener('click', startCompass);
  $('#btn-compass-stop')?.addEventListener('click', stopCompass);
}

function currentAssessment() {
  return buildAssessment({ location: state.location, direction: state.direction, analysis: state.analysis, mountingPositions: state.mounts });
}

function renderAssessment() {
  const v = $('#view-assess');
  if (!state.location) { v.innerHTML = `<div class="empty"><strong>No property selected</strong><span>Search for a property to build the pre-visit assessment.</span></div>`; return; }
  const a = currentAssessment();
  const loc = state.location; const d = state.direction;
  const featureBlock = (() => {
    if (state.featureStatus === 'loading') return `<p><span class="spinner" aria-hidden="true"></span> Loading mapped buildings and trees…</p>`;
    if (state.featureStatus === 'error') return notice('error', `${esc(state.featureError)} <button type="button" class="btn" id="retry-features">Try again</button>`);
    if (!state.analysis) return `<p>Neighbouring buildings and trees from OpenStreetMap are not loaded.</p><div class="btn-row"><button type="button" class="btn" id="load-features">Load buildings &amp; trees</button></div>`;
    const list = state.analysis.features.filter((f) => f.zone !== 'outside').slice(0, 12);
    return `<p>${state.analysis.summary.total} mapped features within 140 m; ${state.analysis.summary.inClearance} in the northern bands. Angles assume a ${settings.mountHeight} m mount height.</p>
      ${list.length ? `<ul class="feature-list">${list.map((f) => `<li><span>${esc(f.name || f.kind)}</span>
        <span class="chip ${f.concern === 'high' ? 'chip-warn' : f.concern === 'check' ? 'chip-neutral' : 'chip-good'}">${f.concern === 'high' ? 'Concern' : f.concern === 'check' ? 'Check' : 'Low'}</span>
        <span class="meta mono">${Math.round(f.distance)} m · ${formatBearing(f.bearing)} ${compassPoint(f.bearing)} · ${f.elevation == null ? 'height unknown' : `${Math.max(0, Math.round(f.elevation))}° up`} · ${f.zone}</span></li>`).join('')}</ul>` : ''}`;
  })();
  v.innerHTML = `
    <div class="status-banner status-${a.status.id}">
      <span class="sub">Assessment status</span>
      <strong>${esc(a.status.label)}</strong>
      ${a.reasons.map((r) => `<p>${esc(r)}</p>`).join('')}
    </div>
    <div class="block">
      <h3>Property</h3>
      <dl class="kv">
        <dt>Address</dt><dd>${esc(loc.label)}</dd>
        <dt>Postcode</dt><dd class="mono">${esc(loc.postcode || '—')}</dd>
        <dt>Lat, lon</dt><dd class="mono">${loc.lat.toFixed(6)}, ${loc.lon.toFixed(6)}</dd>
        <dt>Location</dt><dd>${esc(locationAccuracyLabel(loc.accuracy))}</dd>
        <dt>Sky sector</dt><dd class="mono">${d.status === 'estimate' ? `${formatBearing(d.alignment.from)}–${formatBearing(d.alignment.to)}` : 'none'}</dd>
        <dt>Confidence</dt><dd>${esc(d.confidence.label)}</dd>
      </dl>
    </div>
    ${a.concerns.length ? `<div class="block"><h3>Needs attention</h3><ul>${a.concerns.map((c) => `<li>${esc(c)}</li>`).join('')}</ul></div>` : ''}
    <div class="block"><h3>Mapped surroundings</h3>${featureBlock}
      ${a.observations.length ? `<ul>${a.observations.map((o) => `<li>${esc(o)}</li>`).join('')}</ul>` : ''}</div>
    <div class="block">
      <h3>Candidate mounting positions</h3>
      ${state.mounts.length ? `<ul class="mount-list">${state.mounts.map((m, i) => `<li><span class="mount-badge">M${i + 1}</span>
        <label class="visually-hidden" for="mount-${m.id}">Mount M${i + 1} description</label>
        <input id="mount-${m.id}" data-mount="${m.id}" value="${esc(m.label)}" placeholder="e.g. gable end, chimney bracket">
        <button type="button" class="btn-ghost btn-icon" data-remove-mount="${m.id}" aria-label="Remove M${i + 1}">${ICON.x}</button></li>`).join('')}</ul>`
        : '<p>None yet. Tap <strong>Add mount</strong> and tap the map.</p>'}
    </div>
    <div class="block"><h3>Verify on site</h3>
      <ul class="checklist">${a.toVerify.map((t, i) => `<li><input type="checkbox" id="verify-${i}"><label for="verify-${i}">${esc(t)}</label></li>`).join('')}</ul></div>
    <div class="block">
      <h3>${state.jobId ? 'Update saved job' : 'Save as job'}</h3>
      <div class="field"><label for="job-ref">Job reference</label><input id="job-ref" maxlength="60" placeholder="e.g. JOB-1042" value="${esc(state.jobId ? repo.get(state.jobId)?.reference ?? '' : '')}">
        <span class="hint">Use your job number, not the customer’s name.</span></div>
      <div class="btn-row"><button type="button" class="btn-primary" id="save-job">${state.jobId ? 'Update job' : 'Save job'}</button></div>
    </div>`;
  $('#load-features')?.addEventListener('click', loadFeatures);
  $('#retry-features')?.addEventListener('click', loadFeatures);
  v.querySelectorAll('[data-mount]').forEach((inp) => inp.addEventListener('input', () => {
    const m = state.mounts.find((x) => x.id === inp.dataset.mount); if (m) m.label = inp.value;
  }));
  v.querySelectorAll('[data-remove-mount]').forEach((b) => b.addEventListener('click', () => {
    state.mounts = state.mounts.filter((x) => x.id !== b.dataset.removeMount); drawAll(); renderAssessment();
  }));
  $('#save-job').addEventListener('click', saveCurrentJob);
}

function directionSnapshot(d) {
  if (d.status !== 'estimate') return { status: d.status, reasons: d.reasons, modelVersion: d.modelVersion, profileId: d.profileId };
  const { status, centreAzimuth, centreCompass, alignment, clearance, geoArc, confidence, method, modelVersion, profileId, isDemonstrationData } = d;
  return { status, centreAzimuth, centreCompass, alignment, clearance, geoArc, confidence, method, modelVersion, profileId, isDemonstrationData };
}

function saveCurrentJob() {
  const loc = state.location; if (!loc) return;
  const ref = $('#job-ref').value.trim();
  const a = currentAssessment();
  const existing = state.jobId ? repo.get(state.jobId) : null;
  const base = existing ?? createJob({ status: a.status.id === 'needs-verification' ? 'needs-verification' : 'planned' });
  try {
    const saved = repo.save({
      ...base,
      reference: ref || base.reference || `JOB-${new Date().toISOString().slice(2, 10).replace(/-/g, '')}`,
      address: loc.label, postcode: loc.postcode ?? '',
      lat: loc.lat, lon: loc.lon, locationAccuracy: loc.accuracy, locationSource: loc.source,
      direction: directionSnapshot(state.direction),
      assessmentStatus: a.status.id,
      mountingPositions: state.mounts.map((m) => ({ ...m })),
    });
    state.jobId = saved.id;
    toast(existing ? 'Job updated' : 'Job saved on this device');
    renderAll();
  } catch (err) { toast(err.message); }
}

function updateJobsCount() { const n = repo.list().length; $('#jobs-count').textContent = n ? String(n) : ''; }

function renderJobs() {
  const v = $('#view-jobs');
  if (state.openJobId) { renderJobDetail(v, repo.get(state.openJobId)); return; }
  const all = repo.list();
  const jobs = state.jobFilter === 'all' ? all : all.filter((j) => j.status === state.jobFilter);
  v.innerHTML = `
    ${persistent ? '' : notice('warn', 'This browser is not allowing storage, so jobs will be lost when the page closes.')}
    <div class="filters" role="group" aria-label="Filter jobs">
      ${[{ id: 'all', label: 'All' }, ...JOB_STATUSES].map((s) => `<button type="button" data-filter="${s.id}" aria-pressed="${state.jobFilter === s.id}">${esc(s.label)}</button>`).join('')}
    </div>
    ${jobs.length ? `<ul class="job-list">${jobs.map((j) => `<li><button type="button" class="job" data-job="${j.id}">
        <span class="job-ref">${esc(j.reference)}</span>${statusChip(j.status)}
        <span class="job-addr">${esc(j.address)}</span>
        <span class="job-date">Updated ${new Date(j.updatedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}</span>
      </button></li>`).join('')}</ul>`
      : `<div class="empty"><strong>${all.length ? 'No jobs with this status' : 'No saved jobs yet'}</strong><span>Find a property, then save it from the Assessment tab.</span></div>`}
    <div class="block"><h3>Backup</h3>
      <p>Jobs are stored only in this browser on this device. Export regularly.</p>
      <div class="btn-row"><button type="button" class="btn" id="export-jobs">Export all (JSON)</button>
      <label class="btn" for="import-jobs">Import</label><input type="file" id="import-jobs" accept="application/json,.json" hidden></div>
    </div>`;
  v.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => { state.jobFilter = b.dataset.filter; renderJobs(); }));
  v.querySelectorAll('[data-job]').forEach((b) => b.addEventListener('click', () => { state.openJobId = b.dataset.job; renderJobs(); }));
  $('#export-jobs').addEventListener('click', () => download(`sky-sector-jobs-${new Date().toISOString().slice(0, 10)}.json`, repo.exportJson(), 'application/json'));
  $('#import-jobs').addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { const r = repo.importJson(await f.text()); toast(`Imported ${r.added} new, ${r.updated} updated`); renderAll(); }
    catch (err) { toast(`Import failed: ${err.message}`); }
  });
}

function statusChip(id) {
  const s = JOB_STATUSES.find((x) => x.id === id);
  const cls = { planned: 'chip-ok', 'needs-verification': 'chip-warn', scheduled: 'chip-neutral', installed: 'chip-good', 'not-proceeding': 'chip-bad' }[id] ?? 'chip-neutral';
  return `<span class="chip ${cls}">${esc(s?.label ?? id)}</span>`;
}

function renderJobDetail(v, job) {
  if (!job) { state.openJobId = null; renderJobs(); return; }
  const d = job.direction;
  v.innerHTML = `
    <div class="btn-row"><button type="button" class="btn-ghost" id="job-back">← All jobs</button><button type="button" class="btn" id="job-show">Show on map</button></div>
    <div class="block">
      <h2>${esc(job.reference)}</h2>
      <dl class="kv">
        <dt>Address</dt><dd>${esc(job.address)}</dd>
        <dt>Postcode</dt><dd class="mono">${esc(job.postcode || '—')}</dd>
        <dt>Lat, lon</dt><dd class="mono">${job.lat?.toFixed(6)}, ${job.lon?.toFixed(6)}</dd>
        <dt>Location</dt><dd>${esc(locationAccuracyLabel(job.locationAccuracy))}</dd>
        <dt>Created</dt><dd>${new Date(job.createdAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}</dd>
        <dt>Estimate</dt><dd class="mono">${d?.status === 'estimate' ? `${formatBearing(d.alignment.from)}–${formatBearing(d.alignment.to)}` : 'none'}</dd>
        <dt>Method</dt><dd>${esc(d?.method ?? '—')}</dd>
        <dt>Mounts</dt><dd>${job.mountingPositions.length ? job.mountingPositions.map((m, i) => `M${i + 1} ${esc(m.label || '')}`).join(', ') : 'none'}</dd>
      </dl>
    </div>
    <form class="block" id="job-form">
      <div class="field"><label for="jf-ref">Job reference</label><input id="jf-ref" name="reference" maxlength="60" value="${esc(job.reference)}"></div>
      <div class="field"><label for="jf-status">Job status</label><select id="jf-status" name="status">${JOB_STATUSES.map((s) => `<option value="${s.id}"${s.id === job.status ? ' selected' : ''}>${esc(s.label)}</option>`).join('')}</select></div>
      <div class="field"><label for="jf-notes">Installation notes</label><textarea id="jf-notes" name="notes" placeholder="Access, roof type, cable route, ladder needed…">${esc(job.notes)}</textarea></div>
      <h3>On-site findings</h3>
      <div class="field-row">
        <div class="field"><label for="jf-bearing">Bearing from Starlink app (°)</label><input id="jf-bearing" name="observedBearing" type="number" inputmode="decimal" min="0" max="359.9" step="0.1" value="${job.onSite.observedBearing ?? ''}"></div>
        <div class="field"><label for="jf-tilt">Tilt from app (°)</label><input id="jf-tilt" name="observedTilt" type="number" inputmode="decimal" min="0" max="90" step="0.1" value="${job.onSite.observedTilt ?? ''}"></div>
      </div>
      <span class="hint">Recorded bearings improve future estimates near this job (shown in green on the compass).</span>
      <div class="field"><label for="jf-obs">Obstruction check result</label><textarea id="jf-obs" name="obstructionNotes" placeholder="e.g. App obstruction check clear at M1; oak to NNE blocks M2">${esc(job.onSite.obstructionNotes)}</textarea></div>
      <div class="field"><label for="jf-find">Other findings</label><textarea id="jf-find" name="findings">${esc(job.onSite.findings)}</textarea></div>
      <div class="btn-row"><button type="submit" class="btn-primary">Save changes</button></div>
    </form>
    <div class="block">
      <h3>Photos</h3>
      <div class="photos" id="job-photos">${job.photos.map((id) => `<div class="photo" data-photo="${id}"><button type="button" aria-label="Delete photo" data-del-photo="${id}">${ICON.x}</button></div>`).join('')}</div>
      <div class="btn-row"><label class="btn" for="jf-photo">Add photo</label><input id="jf-photo" type="file" accept="image/*" capture="environment" hidden></div>
    </div>
    <div class="block">
      <h3>Report</h3>
      <div class="btn-row"><button type="button" class="btn" id="job-copy">Copy report</button><button type="button" class="btn" id="job-download">Download .txt</button></div>
    </div>
    <div class="block" id="delete-zone"><div class="btn-row"><button type="button" class="btn-danger" id="job-delete">Delete job</button></div></div>`;

  $('#job-back').addEventListener('click', () => { state.openJobId = null; renderJobs(); });
  $('#job-show').addEventListener('click', () => openJobOnMap(job.id));
  $('#job-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    repo.save({ ...repo.get(job.id), reference: f.get('reference').trim() || job.reference, status: f.get('status'), notes: f.get('notes'),
      onSite: { observedBearing: f.get('observedBearing') === '' ? null : normaliseBearing(Number(f.get('observedBearing'))), observedTilt: f.get('observedTilt') === '' ? null : Number(f.get('observedTilt')), obstructionNotes: f.get('obstructionNotes'), findings: f.get('findings') } });
    toast('Job saved'); renderJobs(); updateJobsCount(); renderSector();
  });
  $('#jf-photo').addEventListener('change', async (e) => {
    const file = e.target.files[0]; if (!file) return;
    try { const id = await photos.addPhoto(file, job.id); const j = repo.get(job.id); repo.save({ ...j, photos: [...j.photos, id] }); toast('Photo added'); renderJobs(); }
    catch (err) { toast(`Could not save photo: ${err.message}`); }
  });
  v.querySelectorAll('[data-photo]').forEach(async (el) => {
    try { const url = await photos.getPhotoUrl(el.dataset.photo); if (url) el.insertAdjacentHTML('afterbegin', `<img src="${url}" alt="Site photo">`); } catch { /* photo store unavailable */ }
  });
  v.querySelectorAll('[data-del-photo]').forEach((b) => b.addEventListener('click', async () => {
    try { await photos.deletePhoto(b.dataset.delPhoto); } catch { /* already gone */ }
    const j = repo.get(job.id); repo.save({ ...j, photos: j.photos.filter((p) => p !== b.dataset.delPhoto) }); renderJobs();
  }));
  const report = () => buildReport(repo.get(job.id));
  $('#job-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(report()); toast('Report copied'); } catch { toast('Copy not allowed here. Use Download instead.'); }
  });
  $('#job-download').addEventListener('click', () => download(`${job.reference || 'job'}-report.txt`, report(), 'text/plain'));
  $('#job-delete').addEventListener('click', () => {
    $('#delete-zone').innerHTML = `<div class="confirm"><p>Delete ${esc(job.reference)} and its photos from this device? This cannot be undone.</p>
      <div class="btn-row"><button type="button" class="btn-danger" id="job-delete-yes">Delete</button><button type="button" class="btn-ghost" id="job-delete-no">Keep</button></div></div>`;
    $('#job-delete-no').addEventListener('click', () => renderJobs());
    $('#job-delete-yes').addEventListener('click', async () => {
      for (const p of job.photos) { try { await photos.deletePhoto(p); } catch { /* ignore */ } }
      repo.delete(job.id); if (state.jobId === job.id) state.jobId = null;
      state.openJobId = null; toast('Job deleted'); renderAll();
    });
  });
}

function openJobOnMap(id) {
  const j = repo.get(id); if (!j || !Number.isFinite(j.lat)) return;
  state.features = null; state.analysis = null; state.featureStatus = 'idle';
  state.mounts = j.mountingPositions.map((m) => ({ ...m }));
  state.jobId = j.id;
  setLocation({ lat: j.lat, lon: j.lon, accuracy: j.locationAccuracy, source: j.locationSource, label: j.address || j.reference, postcode: j.postcode });
  selectTab('assess');
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ---------- settings ----------
function persistSettings() { try { saveSettings(storage, settings); } catch { /* storage full or blocked */ } }

function renderSettings() {
  const v = $('#view-settings');
  const p = UK_NORTHERN_SKY_PROFILE;
  v.innerHTML = `
    <form class="block" id="settings-form">
      <h2>Settings</h2>
      <h3>Map</h3>
      <div class="field"><label for="s-layer">Base map</label>
        <select id="s-layer" name="baseLayer">
          <option value="osm"${settings.baseLayer === 'osm' ? ' selected' : ''}>OpenStreetMap</option>
          <option value="satellite"${settings.baseLayer === 'satellite' ? ' selected' : ''}>Satellite (Esri World Imagery)</option>
          <option value="custom"${settings.baseLayer === 'custom' ? ' selected' : ''}>Custom tile server</option>
        </select></div>
      <div class="field"><label for="s-tiles">Custom tile URL</label><input id="s-tiles" name="customTileUrl" placeholder="https://tiles.example.com/{z}/{x}/{y}.png?key=…" value="${esc(settings.customTileUrl)}">
        <span class="hint">For a paid provider (MapTiler, Thunderforest, OS Maps API). The key stays on this device only.</span></div>
      <div class="field"><label for="s-tiles-attr">Custom tile attribution</label><input id="s-tiles-attr" name="customTileAttribution" value="${esc(settings.customTileAttribution)}"></div>

      <h3>Sky sector model</h3>
      <p class="hint">Profile: ${esc(p.name)} v${esc(p.version)}. Leave blank for the profile defaults.</p>
      <div class="field-row">
        <div class="field"><label for="s-align">Alignment ± (°)</label><input id="s-align" name="alignmentHalfWidth" type="number" min="5" max="90" placeholder="${p.alignmentHalfWidth}" value="${settings.alignmentHalfWidth ?? ''}"></div>
        <div class="field"><label for="s-clear">Clearance ± (°)</label><input id="s-clear" name="clearanceHalfWidth" type="number" min="5" max="120" placeholder="${p.clearanceHalfWidth}" value="${settings.clearanceHalfWidth ?? ''}"></div>
      </div>
      <div class="field-row">
        <div class="field"><label for="s-mount">Mount height (m)</label><input id="s-mount" name="mountHeight" type="number" min="0" max="40" step="0.5" value="${settings.mountHeight}"></div>
        <div class="field"><label for="s-concern">Concern angle (°)</label><input id="s-concern" name="concernElevation" type="number" min="5" max="80" value="${settings.concernElevation}"></div>
      </div>
      <span class="hint">Concern angle is your own planning threshold for how high an obstruction may rise above the mount. It is not a Starlink specification.</span>
      <div class="field"><label for="s-decl">Magnetic declination (° east, negative for west)</label><input id="s-decl" name="declinationEast" type="number" min="-30" max="30" step="0.1" value="${settings.declinationEast}">
        <span class="hint">UK values are close to 0°. Look up the current value on the <a href="https://geomag.bgs.ac.uk/data_service/models_compass/wmm_calc.html" target="_blank" rel="noopener">BGS declination calculator</a>.</span></div>

      <h3>Data providers</h3>
      <div class="field"><label for="s-email">Contact email for Nominatim (optional)</label><input id="s-email" name="nominatimEmail" type="email" value="${esc(settings.nominatimEmail)}">
        <span class="hint">Nominatim's usage policy asks heavy users to identify themselves. Sent only to nominatim.openstreetmap.org.</span></div>
      <div class="field"><label for="s-overpass">Overpass API URL</label><input id="s-overpass" name="overpassUrl" placeholder="${DEFAULT_OVERPASS_URL}" value="${esc(settings.overpassUrl)}"></div>
      <div class="btn-row"><button type="submit" class="btn-primary">Save settings</button><button type="button" class="btn-ghost" id="s-reset">Reset to defaults</button></div>
    </form>
    <div class="block">
      <h3>Providers in use</h3>
      <ul>
        <li><strong>Postcodes:</strong> postcodes.io (open ONS/OS data, centroids only).</li>
        <li><strong>Addresses:</strong> Nominatim / OpenStreetMap. House-level coverage is incomplete in the UK.</li>
        <li><strong>Buildings &amp; trees:</strong> OpenStreetMap via Overpass.</li>
        <li><strong>Map:</strong> OpenStreetMap tiles; satellite imagery by Esri.</li>
      </ul>
      <p class="hint">Not affiliated with or endorsed by Starlink or SpaceX.</p>
    </div>`;
  $('#settings-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const optNum = (k) => (f.get(k) === '' ? null : Number(f.get(k)));
    settings = { ...settings,
      baseLayer: f.get('baseLayer'), customTileUrl: f.get('customTileUrl').trim(), customTileAttribution: f.get('customTileAttribution').trim(),
      alignmentHalfWidth: optNum('alignmentHalfWidth'), clearanceHalfWidth: optNum('clearanceHalfWidth'),
      mountHeight: Number(f.get('mountHeight')) || 0, concernElevation: Number(f.get('concernElevation')) || 25,
      declinationEast: Number(f.get('declinationEast')) || 0,
      nominatimEmail: f.get('nominatimEmail').trim(), overpassUrl: f.get('overpassUrl').trim() };
    persistSettings(); geocoder = makeGeocoder(); setBaseLayer(settings.baseLayer);
    if (state.location) setLocation(state.location, { fit: false });
    toast('Settings saved');
  });
  $('#s-reset').addEventListener('click', () => {
    settings = { ...DEFAULT_SETTINGS }; persistSettings(); geocoder = makeGeocoder(); setBaseLayer('osm'); renderSettings();
    if (state.location) setLocation(state.location, { fit: false });
    toast('Settings reset');
  });
}

// ---------- live compass ----------
let compassHandler = null;
async function startCompass() {
  try {
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      const r = await DeviceOrientationEvent.requestPermission();
      if (r !== 'granted') { toast('Compass permission denied.'); return; }
    }
  } catch { toast('Compass is not available.'); return; }
  let last = 0;
  compassHandler = (e) => {
    let mag = null;
    if (typeof e.webkitCompassHeading === 'number') mag = e.webkitCompassHeading;          // iOS, magnetic
    else if (e.absolute && typeof e.alpha === 'number') mag = normaliseBearing(360 - e.alpha); // Android absolute
    if (mag == null) return;
    const now = Date.now(); if (now - last < 250) return; last = now;
    state.heading = normaliseBearing(mag + (Number(settings.declinationEast) || 0));
    if (state.tab === 'sector') renderSector();
  };
  window.addEventListener('deviceorientationabsolute', compassHandler);
  window.addEventListener('deviceorientation', compassHandler);
  setTimeout(() => { if (state.heading == null && compassHandler) { toast('No compass reading. This device or browser may not have one.'); } }, 3000);
}
function stopCompass() {
  window.removeEventListener('deviceorientationabsolute', compassHandler);
  window.removeEventListener('deviceorientation', compassHandler);
  compassHandler = null; state.heading = null; renderSector();
}

// ---------- tabs & sheet ----------
function selectTab(tab) {
  state.tab = tab;
  for (const t of ['sector', 'assess', 'jobs', 'settings']) {
    $(`#tab-${t}`).setAttribute('aria-selected', String(t === tab));
    $(`#view-${t}`).hidden = t !== tab;
  }
  if (tab === 'settings') renderSettings();
  if (tab === 'jobs') renderJobs();
}
for (const t of ['sector', 'assess', 'jobs', 'settings']) $(`#tab-${t}`).addEventListener('click', () => selectTab(t));
$('.tabs').addEventListener('keydown', (e) => {
  const order = ['sector', 'assess', 'jobs', 'settings'];
  const i = order.indexOf(state.tab);
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    const next = order[(i + (e.key === 'ArrowRight' ? 1 : order.length - 1)) % order.length];
    selectTab(next); $(`#tab-${next}`).focus();
  }
});

$('#sheet-handle').addEventListener('click', () => {
  const p = $('#panel');
  const expanded = p.classList.contains('is-expanded');
  const collapsed = p.classList.contains('is-collapsed');
  p.classList.remove('is-expanded', 'is-collapsed');
  if (!expanded && !collapsed) p.classList.add('is-expanded');
  else if (expanded) p.classList.add('is-collapsed');
  $('#sheet-handle').setAttribute('aria-expanded', String(!expanded && !collapsed));
});

// ---------- boot ----------
if (isPhone()) $('#legend').open = false;
setBaseLayer(settings.baseLayer);
renderAll();
selectTab('sector');
window.addEventListener('online', () => toast('Back online'));
window.addEventListener('offline', () => toast('Offline: search and map tiles need a connection. Saved jobs still work.'));
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => { /* offline shell unavailable */ });
}
// Exposed for automated browser tests only.
window.__slp = { state, map, repo };
