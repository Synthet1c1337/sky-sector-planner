import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOverpass, parseHeight, analyseFeatures, buildOverpassQuery, fetchMappedFeatures } from '../js/obstructions.js';
import { estimateDirection } from '../js/direction.js';
import { destinationPoint } from '../js/geo.js';
import { mockFetch, json, badJson, networkDown } from './helpers.mjs';

const P = { lat: 52.4153, lon: -4.0829, accuracy: 'installer-placed' };
const D = estimateDirection(P);

// Square building of side `s` metres centred `dist` metres away on `bearing`.
function box(bearing, dist, s = 8) {
  const c = destinationPoint(P.lat, P.lon, bearing, dist);
  const corner = (db, dn) => destinationPoint(destinationPoint(c.lat, c.lon, 0, dn).lat, destinationPoint(c.lat, c.lon, 0, dn).lon, 90, db);
  const pts = [corner(-s / 2, -s / 2), corner(s / 2, -s / 2), corner(s / 2, s / 2), corner(-s / 2, s / 2)];
  return [...pts, pts[0]];
}

test('builds a bounded Overpass query', () => {
  const q = buildOverpassQuery(52.4, -4.08, 120);
  assert.match(q, /around:120,52.4,-4.08/);
  assert.match(q, /"building"/);
  assert.match(q, /"natural"="tree"/);
  assert.match(q, /out geom/);
});

test('parses heights from tags', () => {
  assert.deepEqual(parseHeight({ height: '12' }), { metres: 12, source: 'mapped height tag' });
  assert.equal(parseHeight({ height: '12 m' }).metres, 12);
  assert.ok(Math.abs(parseHeight({ height: "30'" }).metres - 9.144) < 1e-6);
  assert.equal(parseHeight({ 'building:levels': '2' }).metres, 7);
  assert.equal(parseHeight({ 'building:levels': '2', 'roof:levels': '1' }).metres, 10);
  assert.equal(parseHeight({}), null);
  assert.equal(parseHeight({ height: 'tall' }), null);
});

test('parses Overpass elements and skips unknowns', () => {
  const f = parseOverpass({ elements: [
    { type: 'way', id: 1, tags: { building: 'house', 'building:levels': '2' }, geometry: box(0, 20) },
    { type: 'node', id: 2, lat: 52.416, lon: -4.083, tags: { natural: 'tree' } },
    { type: 'way', id: 3, tags: { highway: 'residential' }, geometry: box(0, 30) },
    { type: 'relation', id: 4, tags: { building: 'yes' }, members: [{ role: 'outer', geometry: box(90, 40) }] },
  ] });
  assert.deepEqual(f.map((x) => x.kind), ['building', 'tree', 'building']);
  assert.equal(f[0].height.metres, 7);
  assert.equal(parseOverpass({}).length, 0);
});

test('classifies features by band and elevation angle', () => {
  const features = [
    { id: 'tall-north', kind: 'building', geometry: box(5, 20), height: { metres: 20, source: 't' } },     // ~37° up → high
    { id: 'low-north', kind: 'building', geometry: box(355, 30), height: { metres: 6, source: 't' } },     // ~2° → low
    { id: 'south', kind: 'building', geometry: box(180, 15), height: { metres: 30, source: 't' } },        // outside
    { id: 'tree-ne', kind: 'tree', geometry: [destinationPoint(P.lat, P.lon, 45, 18)], height: null },      // clearance, unknown → check
  ];
  const a = analyseFeatures(features, P, D, { mountHeight: 5, concernElevation: 25 });
  const by = Object.fromEntries(a.features.map((f) => [f.id, f]));
  assert.equal(by['tall-north'].zone, 'alignment');
  assert.equal(by['tall-north'].concern, 'high');
  assert.ok(by['tall-north'].elevation > 30 && by['tall-north'].elevation < 45);
  assert.equal(by['low-north'].concern, 'low');
  assert.equal(by.south.zone, 'outside');
  assert.equal(by.south.concern, 'none');
  assert.equal(by['tree-ne'].zone, 'clearance');
  assert.equal(by['tree-ne'].concern, 'check');
  assert.equal(a.features[0].id, 'tall-north', 'highest concern first');
  assert.equal(a.summary.high, 1);
  assert.equal(a.summary.unknownHeightInSector, 1);
});

test('recognises the building the pin sits in', () => {
  const own = { id: 'own', kind: 'building', geometry: box(0, 0, 12), height: { metres: 8, source: 't' } };
  const a = analyseFeatures([own], P, D);
  assert.equal(a.ownBuilding.id, 'own');
  assert.equal(a.features.length, 0);
});

test('measures to the nearest wall in the band, not just corners', () => {
  // A long wall 20 m north spanning far east-west: corners are outside the alignment band.
  const w1 = destinationPoint(destinationPoint(P.lat, P.lon, 0, 20).lat, destinationPoint(P.lat, P.lon, 0, 20).lon, 270, 80);
  const w2 = destinationPoint(destinationPoint(P.lat, P.lon, 0, 20).lat, destinationPoint(P.lat, P.lon, 0, 20).lon, 90, 80);
  const a = analyseFeatures([{ id: 'wall', kind: 'building', geometry: [w1, w2], height: null }], P, D);
  assert.equal(a.features[0].zone, 'alignment');
  assert.ok(Math.abs(a.features[0].distance - 20) < 1.5);
});

test('fetch errors are reported, not thrown as crashes', async () => {
  const one = { fallbackUrls: [] };
  await assert.rejects(fetchMappedFeatures(52, -4, { ...one, fetchImpl: mockFetch([[() => true, networkDown]]) }), { code: 'network' });
  await assert.rejects(fetchMappedFeatures(52, -4, { ...one, fetchImpl: mockFetch([[() => true, () => json({}, 429)]]) }), { code: 'rate-limited' });
  await assert.rejects(fetchMappedFeatures(52, -4, { ...one, fetchImpl: mockFetch([[() => true, () => json({}, 500)]]) }), { code: 'bad-response' });
  await assert.rejects(fetchMappedFeatures(52, -4, { ...one, fetchImpl: mockFetch([[() => true, () => badJson()]]) }), { code: 'bad-response' });
  const ok = await fetchMappedFeatures(52, -4, { ...one, fetchImpl: mockFetch([[() => true, () => json({ elements: [] })]]) });
  assert.deepEqual(ok, []);
});

test('502 and 503 count as a busy server', async () => {
  for (const status of [502, 503, 504]) {
    await assert.rejects(fetchMappedFeatures(52, -4, { fallbackUrls: [], fetchImpl: mockFetch([[() => true, () => json({}, status)]]) }), { code: 'rate-limited' });
  }
});

test('a server that never answers times out', async () => {
  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
  await assert.rejects(fetchMappedFeatures(52, -4, { fallbackUrls: [], timeoutMs: 20, fetchImpl: mockFetch([[() => true, hang]]) }), { code: 'timeout' });
});

test('falls back to the next server when the main one fails', async () => {
  const fetchImpl = mockFetch([
    [(u) => u.startsWith('https://main.example'), () => json({}, 502)],
    [(u) => u.startsWith('https://backup.example'), () => json({ elements: [{ type: 'node', id: 1, lat: 52, lon: -4, tags: { natural: 'tree' } }] })],
  ]);
  const f = await fetchMappedFeatures(52, -4, { url: 'https://main.example/api', fallbackUrls: ['https://backup.example/api'], fetchImpl });
  assert.equal(f.length, 1);
  assert.deepEqual(fetchImpl.calls.map((c) => c.url), ['https://main.example/api', 'https://backup.example/api']);
});

test('does not call the fallback when the main server answers', async () => {
  const fetchImpl = mockFetch([[() => true, () => json({ elements: [] })]]);
  await fetchMappedFeatures(52, -4, { url: 'https://main.example/api', fallbackUrls: ['https://backup.example/api'], fetchImpl });
  assert.equal(fetchImpl.calls.length, 1);
});

test('reports the last error when every server fails, and skips duplicates', async () => {
  const fetchImpl = mockFetch([[() => true, () => json({}, 503)]]);
  await assert.rejects(fetchMappedFeatures(52, -4, { url: 'https://a.example', fallbackUrls: ['https://a.example', 'https://b.example'], fetchImpl }), { code: 'rate-limited' });
  assert.equal(fetchImpl.calls.length, 2);
});
