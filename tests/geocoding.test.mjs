import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PostcodesIoProvider, NominatimProvider, GeocodingService, GeocodingError } from '../js/geocoding.js';
import { mockFetch, json, badJson, networkDown, POSTCODES_IO_OK, NOMINATIM_TWO_HOUSES } from './helpers.mjs';

const isPc = (u) => u.includes('api.postcodes.io');
const isNom = (u) => u.includes('nominatim');
const nominatim = (fetchImpl) => new NominatimProvider({ fetchImpl, minIntervalMs: 0 });

test('postcodes.io: returns a labelled centroid, never an exact address', async () => {
  const f = mockFetch([[isPc, () => json(POSTCODES_IO_OK)]]);
  const r = await new PostcodesIoProvider({ fetchImpl: f }).lookupPostcode('sy231de');
  assert.equal(r.accuracy, 'postcode-centroid');
  assert.equal(r.lat, 52.41543);
  assert.match(r.label, /Postcode centre/);
  assert.match(f.calls[0].url, /postcodes\/SY231DE$/);
});

test('postcodes.io: error handling', async () => {
  const p = (fetchImpl) => new PostcodesIoProvider({ fetchImpl });
  await assert.rejects(p(mockFetch([])).lookupPostcode('nonsense'), (e) => e instanceof GeocodingError && e.code === 'invalid-input');
  await assert.rejects(p(mockFetch([[isPc, () => json({ status: 404, error: 'Postcode not found' }, 404)]])).lookupPostcode('SW1A 1AA'), { code: 'not-found' });
  await assert.rejects(p(mockFetch([[isPc, networkDown]])).lookupPostcode('SW1A 1AA'), { code: 'network' });
  await assert.rejects(p(mockFetch([[isPc, () => json({}, 429)]])).lookupPostcode('SW1A 1AA'), { code: 'rate-limited' });
  await assert.rejects(p(mockFetch([[isPc, () => json({}, 500)]])).lookupPostcode('SW1A 1AA'), { code: 'bad-response' });
  await assert.rejects(p(mockFetch([[isPc, () => badJson()]])).lookupPostcode('SW1A 1AA'), { code: 'bad-response' });
  // Postcode exists but has no coordinates (e.g. some non-geographic codes)
  await assert.rejects(p(mockFetch([[isPc, () => json({ result: { postcode: 'SW1A 1AA', latitude: null, longitude: null } })]])).lookupPostcode('SW1A 1AA'), { code: 'bad-response' });
});

test('nominatim: classifies accuracy and flags other postcodes', async () => {
  const f = mockFetch([[isNom, () => json(NOMINATIM_TWO_HOUSES)]]);
  const r = await nominatim(f).searchAddress('14, SY23 1DE', { postcode: 'SY23 1DE' });
  assert.equal(r.length, 3);
  assert.ok(r.every((x) => x.accuracy === 'address-point'));
  assert.equal(r[2].postcodeMismatch, true);
  assert.match(f.calls[0].url, /countrycodes=gb/);
  assert.match(f.calls[0].url, /format=jsonv2/);
});

test('nominatim: rejects tiny queries and tolerates junk', async () => {
  await assert.rejects(nominatim(mockFetch([])).searchAddress('a'), { code: 'invalid-input' });
  const f = mockFetch([[isNom, () => json([{ lat: 'x', lon: 'y' }, { lat: '52', lon: '-1', display_name: 'High Street', addresstype: 'road', category: 'highway', address: {} }])]]);
  const r = await nominatim(f).searchAddress('High Street');
  assert.equal(r.length, 1);
  assert.equal(r[0].accuracy, 'street');
});

test('nominatim: respects the one-request-per-second policy', async () => {
  let t = 0;
  const f = mockFetch([[isNom, () => json([])]]);
  const p = new NominatimProvider({ fetchImpl: f, minIntervalMs: 30, now: () => t });
  await p.searchAddress('first query');
  const start = Date.now();
  await p.searchAddress('second query');
  assert.ok(Date.now() - start >= 25, 'second request waited');
});

test('service: bare postcode gives the centroid only', async () => {
  const f = mockFetch([[isPc, () => json(POSTCODES_IO_OK)]]);
  const s = new GeocodingService({ postcodeProvider: new PostcodesIoProvider({ fetchImpl: f }), addressProvider: nominatim(f) });
  const { results } = await s.search('SY23 1DE');
  assert.equal(results.length, 1);
  assert.equal(results[0].accuracy, 'postcode-centroid');
  assert.ok(!f.calls.some((c) => isNom(c.url)), 'no address search without a house number');
});

test('service: postcode + house lists address matches first, hides other postcodes, warns on ambiguity', async () => {
  const f = mockFetch([[isPc, () => json(POSTCODES_IO_OK)], [isNom, () => json(NOMINATIM_TWO_HOUSES)]]);
  const s = new GeocodingService({ postcodeProvider: new PostcodesIoProvider({ fetchImpl: f }), addressProvider: nominatim(f) });
  const { results, warnings } = await s.search('sy23 1de', { houseNameOrNumber: '14' });
  assert.deepEqual(results.map((r) => r.accuracy), ['address-point', 'address-point', 'postcode-centroid']);
  assert.ok(results.every((r) => !/Cardiff/.test(r.label)));
  assert.ok(warnings.some((w) => /different postcode/.test(w)));
  assert.ok(warnings.some((w) => /Several properties/.test(w)));
});

test('service: address search failure falls back to the centroid with a warning', async () => {
  const f = mockFetch([[isPc, () => json(POSTCODES_IO_OK)], [isNom, networkDown]]);
  const s = new GeocodingService({ postcodeProvider: new PostcodesIoProvider({ fetchImpl: f }), addressProvider: nominatim(f) });
  const { results, warnings } = await s.search('SY23 1DE', { houseNameOrNumber: 'Rose Cottage' });
  assert.equal(results.length, 1);
  assert.equal(results[0].accuracy, 'postcode-centroid');
  assert.ok(warnings.some((w) => /Address search failed/.test(w)));
  assert.ok(warnings.some((w) => /Place the pin/.test(w)));
});

test('service: offline gives a clear network error', async () => {
  const f = mockFetch([[() => true, networkDown]]);
  const s = new GeocodingService({ postcodeProvider: new PostcodesIoProvider({ fetchImpl: f }), addressProvider: nominatim(f) });
  await assert.rejects(s.search('SY23 1DE', { houseNameOrNumber: '14' }), (e) => e.code === 'network' && /connection/.test(e.message));
});

test('service: invalid and unknown postcodes', async () => {
  const f = mockFetch([[isPc, () => json({ status: 404 }, 404)], [isNom, () => json([])]]);
  const s = new GeocodingService({ postcodeProvider: new PostcodesIoProvider({ fetchImpl: f }), addressProvider: nominatim(f) });
  await assert.rejects(s.search(''), { code: 'invalid-input' });
  await assert.rejects(s.search('SW1A 1C'), { code: 'invalid-input' });
  await assert.rejects(s.search('SW1A 9ZZ'), { code: 'not-found' });
  await assert.rejects(s.search('Nowhere Lane, Atlantis'), { code: 'not-found' });
});

test('service: free-text address uses address search', async () => {
  const f = mockFetch([[isPc, () => json(POSTCODES_IO_OK)], [isNom, () => json(NOMINATIM_TWO_HOUSES.slice(0, 1))]]);
  const s = new GeocodingService({ postcodeProvider: new PostcodesIoProvider({ fetchImpl: f }), addressProvider: nominatim(f) });
  const { results } = await s.search('14 Example Street, Aberystwyth SY23 1DE');
  assert.equal(results[0].accuracy, 'address-point');
  assert.equal(results.at(-1).accuracy, 'postcode-centroid');
});
