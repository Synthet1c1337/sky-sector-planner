import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAssessment } from '../js/assessment.js';
import { estimateDirection } from '../js/direction.js';
import { analyseFeatures } from '../js/obstructions.js';
import { destinationPoint } from '../js/geo.js';

const precise = { lat: 52.4153, lon: -4.0829, accuracy: 'installer-placed' };
const centroid = { ...precise, accuracy: 'postcode-centroid' };

test('insufficient data without a location or estimate', () => {
  assert.equal(buildAssessment({ location: null, direction: estimateDirection(null) }).status.id, 'insufficient-data');
  const paris = { lat: 48.85, lon: 2.35, accuracy: 'address-point' };
  assert.equal(buildAssessment({ location: paris, direction: estimateDirection(paris) }).status.id, 'insufficient-data');
});

test('approximate location needs on-site verification', () => {
  const a = buildAssessment({ location: centroid, direction: estimateDirection(centroid), analysis: analyseFeatures([], centroid, estimateDirection(centroid)) });
  assert.equal(a.status.id, 'needs-verification');
  assert.ok(a.concerns.some((c) => /Postcode centre/.test(c)));
});

test('unloaded map features need verification', () => {
  const a = buildAssessment({ location: precise, direction: estimateDirection(precise) });
  assert.equal(a.status.id, 'needs-verification');
});

test('nothing flagged stays a planning estimate, never "suitable"', () => {
  const d = estimateDirection(precise);
  const a = buildAssessment({ location: precise, direction: d, analysis: analyseFeatures([], precise, d) });
  assert.equal(a.status.id, 'planning-estimate');
  assert.equal(a.status.label, 'Planning estimate');
  const text = JSON.stringify(a).toLowerCase();
  assert.ok(!text.includes('suitable'), 'never claims suitability');
  assert.ok(a.toVerify.some((t) => /official Starlink app/.test(t)));
});

test('a tall mapped obstruction in the band is a concern', () => {
  const d = estimateDirection(precise);
  const c = destinationPoint(precise.lat, precise.lon, 0, 15);
  const geometry = [destinationPoint(c.lat, c.lon, 270, 5), destinationPoint(c.lat, c.lon, 90, 5)];
  const analysis = analyseFeatures([{ id: 'b', kind: 'building', name: 'Mill', geometry, height: { metres: 18, source: 'mapped height tag' } }], precise, d);
  const a = buildAssessment({ location: precise, direction: d, analysis });
  assert.equal(a.status.id, 'needs-verification');
  assert.ok(a.concerns.some((x) => /Building "Mill" 15 m/.test(x)));
});

test('asks for the Starlink app obstruction check first', () => {
  const d = estimateDirection(precise);
  const a = buildAssessment({ location: precise, direction: d, analysis: analyseFeatures([], precise, d) });
  assert.match(a.toVerify[0], /obstruction check/);
});
