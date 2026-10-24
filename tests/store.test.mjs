import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JobRepository, MemoryStorage, createJob, loadSettings, saveSettings, DEFAULT_SETTINGS, safeLocalStorage } from '../js/store.js';
import { buildReport } from '../js/report.js';
import { estimateDirection } from '../js/direction.js';

const sample = (over = {}) => createJob({
  reference: 'JOB-1042', address: '14 Example Street, Aberystwyth', postcode: 'SY23 1DE',
  lat: 52.4157, lon: -4.0825, locationAccuracy: 'address-point', locationSource: 'Nominatim',
  direction: estimateDirection({ lat: 52.4157, lon: -4.0825 }),
  mountingPositions: [{ id: 'm1', label: 'Gable end', lat: 52.41572, lon: -4.08251 }], ...over,
}, new Date('2026-10-20T09:00:00Z'));

test('a new job has every required field and sync-ready metadata', () => {
  const j = sample();
  for (const k of ['id', 'reference', 'address', 'postcode', 'lat', 'lon', 'createdAt', 'direction', 'notes', 'mountingPositions', 'photos', 'onSite', 'status', 'ownerId', 'syncState', 'revision', 'schemaVersion']) {
    assert.ok(k in j, k);
  }
  assert.equal(j.status, 'planned');
  assert.equal(j.syncState, 'local');
  assert.equal(j.createdAt, '2026-10-20T09:00:00.000Z');
});

test('saves, lists, updates and deletes', () => {
  const repo = new JobRepository(new MemoryStorage());
  const saved = repo.save(sample());
  assert.equal(repo.list().length, 1);
  assert.equal(saved.revision, 1);
  const updated = repo.save({ ...saved, notes: 'Ladder needed', status: 'installed', onSite: { observedBearing: '352.5' } });
  assert.equal(updated.revision, 2);
  assert.equal(repo.get(saved.id).notes, 'Ladder needed');
  assert.equal(repo.get(saved.id).onSite.observedBearing, 352.5);
  assert.equal(repo.list().length, 1);
  repo.delete(saved.id);
  assert.equal(repo.list().length, 0);
});

test('data survives a reload (new repository on the same storage)', () => {
  const storage = new MemoryStorage();
  const id = new JobRepository(storage).save(sample()).id;
  const reopened = new JobRepository(storage);
  const j = reopened.get(id);
  assert.equal(j.reference, 'JOB-1042');
  assert.equal(j.direction.alignment.from, 335);
  assert.equal(j.mountingPositions[0].label, 'Gable end');
});

test('corrupt storage reads as empty instead of crashing', () => {
  const s = new MemoryStorage(); s.setItem('slp.jobs.v1', '{not json'); 
  assert.deepEqual(new JobRepository(s).list(), []);
  s.setItem('slp.jobs.v1', '{"a":1}');
  assert.deepEqual(new JobRepository(s).list(), []);
});

test('invalid status and numbers are normalised', () => {
  const repo = new JobRepository(new MemoryStorage());
  const j = repo.save(sample({ status: 'bogus', lat: '52.1', onSite: { observedBearing: '' } }));
  assert.equal(j.status, 'planned');
  assert.equal(j.lat, 52.1);
  assert.equal(j.onSite.observedBearing, null);
});

test('export and import round-trip, newer wins', () => {
  const a = new JobRepository(new MemoryStorage());
  const j = a.save(sample());
  const exported = a.exportJson();
  const b = new JobRepository(new MemoryStorage());
  assert.deepEqual(b.importJson(exported), { added: 1, updated: 0 });
  assert.deepEqual(b.importJson(exported), { added: 0, updated: 0 });
  a.save({ ...j, notes: 'changed' }, new Date(Date.now() + 1000));
  assert.deepEqual(b.importJson(a.exportJson()), { added: 0, updated: 1 });
  assert.equal(b.get(j.id).notes, 'changed');
  assert.throws(() => b.importJson('{"nothing":true}'), /does not contain/);
});

test('full storage raises a clear error', () => {
  const full = { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); }, removeItem() {} };
  assert.throws(() => new JobRepository(full).save(sample()), /storage is full/);
});

test('falls back to memory when localStorage is unavailable', () => {
  const r = safeLocalStorage(); // Node has no usable localStorage by default
  assert.ok(r.storage.getItem);
});

test('settings default and persist', () => {
  const s = new MemoryStorage();
  assert.deepEqual(loadSettings(s), { ...DEFAULT_SETTINGS });
  saveSettings(s, { ...DEFAULT_SETTINGS, mountHeight: 7 });
  assert.equal(loadSettings(s).mountHeight, 7);
  s.setItem('slp.settings.v1', 'garbage');
  assert.equal(loadSettings(s).mountHeight, DEFAULT_SETTINGS.mountHeight);
});

test('report contains the key facts and the official-app warning', () => {
  const r = buildReport(sample({ onSite: { observedBearing: 352, findings: 'Clear' } }));
  assert.match(r, /JOB-1042/);
  assert.match(r, /52\.415700, -4\.082500/);
  assert.match(r, /Alignment band: 335° to 025°/);
  assert.match(r, /M1: Gable end/);
  assert.match(r, /Bearing shown by Starlink app: 352°/);
  assert.match(r, /official Starlink app must confirm/);
  const none = buildReport(createJob({ reference: 'X', direction: estimateDirection(null) }));
  assert.match(none, /insufficient data/);
});
