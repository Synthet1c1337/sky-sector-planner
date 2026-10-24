// Job persistence. A repository over a key-value adapter (localStorage in the browser,
// in-memory in tests). Records carry ownerId / syncState / revision so a backend and
// multiple installer accounts can be added later without migrating the data shape.
// Only job-relevant data is kept: a job reference, not customer names or phone numbers.

export const SCHEMA_VERSION = 1;
const KEY = 'slp.jobs.v1';
const SETTINGS_KEY = 'slp.settings.v1';

export const JOB_STATUSES = Object.freeze([
  { id: 'planned', label: 'Planned' },
  { id: 'needs-verification', label: 'Needs verification' },
  { id: 'scheduled', label: 'Visit booked' },
  { id: 'installed', label: 'Installed' },
  { id: 'not-proceeding', label: 'Not proceeding' },
]);

export class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}

export function safeLocalStorage() {
  try {
    const s = globalThis.localStorage;
    const probe = '__slp_probe__';
    s.setItem(probe, '1'); s.removeItem(probe);
    return { storage: s, persistent: true };
  } catch { return { storage: new MemoryStorage(), persistent: false }; }
}

const newId = () => globalThis.crypto?.randomUUID?.() ?? `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export function createJob(input, now = new Date()) {
  const ts = now.toISOString();
  return normaliseJob({
    id: newId(),
    reference: '',
    address: '',
    postcode: '',
    lat: null, lon: null,
    locationAccuracy: 'unknown', locationSource: '',
    direction: null,
    notes: '',
    mountingPositions: [],
    photos: [],
    onSite: { observedBearing: null, observedTilt: null, obstructionNotes: '', findings: '' },
    status: 'planned',
    createdAt: ts, updatedAt: ts,
    ownerId: null, syncState: 'local', revision: 1, schemaVersion: SCHEMA_VERSION,
    ...input,
  });
}

function normaliseJob(j) {
  const num = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  return {
    ...j,
    reference: String(j.reference ?? '').slice(0, 60),
    lat: num(j.lat), lon: num(j.lon),
    mountingPositions: Array.isArray(j.mountingPositions) ? j.mountingPositions : [],
    photos: Array.isArray(j.photos) ? j.photos : [],
    onSite: { observedBearing: null, observedTilt: null, obstructionNotes: '', findings: '', ...(j.onSite ?? {}),
      ...(j.onSite ? { observedBearing: num(j.onSite.observedBearing), observedTilt: num(j.onSite.observedTilt) } : {}) },
    status: JOB_STATUSES.some((s) => s.id === j.status) ? j.status : 'planned',
  };
}

export class JobRepository {
  constructor(storage) { this.storage = storage; }

  list() {
    let raw;
    try { raw = JSON.parse(this.storage.getItem(KEY) ?? '[]'); } catch { raw = []; }
    if (!Array.isArray(raw)) raw = [];
    return raw.map(normaliseJob).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  get(id) { return this.list().find((j) => j.id === id) ?? null; }

  save(job, now = new Date()) {
    const jobs = this.list();
    const i = jobs.findIndex((j) => j.id === job.id);
    const next = normaliseJob({ ...job, updatedAt: now.toISOString(), revision: (i >= 0 ? jobs[i].revision : 0) + 1, syncState: job.ownerId ? 'pending' : 'local' });
    if (i >= 0) jobs[i] = next; else jobs.push(next);
    this.#write(jobs);
    return next;
  }
  delete(id) { this.#write(this.list().filter((j) => j.id !== id)); }

  exportJson() { return JSON.stringify({ app: 'starlink-installer-planner', schemaVersion: SCHEMA_VERSION, exportedAt: new Date().toISOString(), jobs: this.list() }, null, 2); }

  importJson(text) {
    const data = JSON.parse(text);
    const incoming = Array.isArray(data) ? data : data?.jobs;
    if (!Array.isArray(incoming)) throw new Error('This file does not contain any jobs.');
    const jobs = this.list();
    let added = 0, updated = 0;
    for (const j of incoming) {
      if (!j?.id) continue;
      const i = jobs.findIndex((x) => x.id === j.id);
      if (i < 0) { jobs.push(normaliseJob(j)); added++; }
      else if (String(j.updatedAt) > String(jobs[i].updatedAt)) { jobs[i] = normaliseJob(j); updated++; }
    }
    this.#write(jobs);
    return { added, updated };
  }

  #write(jobs) {
    try { this.storage.setItem(KEY, JSON.stringify(jobs)); }
    catch (e) { const err = new Error('Device storage is full. Export and remove old jobs or photos.'); err.cause = e; throw err; }
  }
}

export const DEFAULT_SETTINGS = Object.freeze({
  baseLayer: 'osm',
  alignmentHalfWidth: null,  // null = use the model profile's value
  clearanceHalfWidth: null,
  mountHeight: 5,
  concernElevation: 25,
  declinationEast: 0,
  nominatimEmail: '',
  overpassUrl: '',
  customTileUrl: '',
  customTileAttribution: '',
});

export function loadSettings(storage) {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(storage.getItem(SETTINGS_KEY) ?? '{}') }; }
  catch { return { ...DEFAULT_SETTINGS }; }
}
export function saveSettings(storage, settings) {
  storage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}
