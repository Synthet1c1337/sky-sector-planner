import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateDirection, UK_NORTHERN_SKY_PROFILE, ESTIMATE_STATUS, LOCATION_ACCURACY,
  summariseNearbyObservedBearings, trueToMagnetic, profileApplies, isPreciseLocation,
} from '../js/direction.js';

const ABERYSTWYTH = { lat: 52.4153, lon: -4.0829, accuracy: LOCATION_ACCURACY.ADDRESS };

test('produces a sector, not a single line, for a UK property', () => {
  const d = estimateDirection(ABERYSTWYTH);
  assert.equal(d.status, ESTIMATE_STATUS.ESTIMATE);
  assert.equal(d.centreAzimuth, 0);
  assert.deepEqual([d.alignment.from, d.alignment.to], [335, 25]);
  assert.deepEqual([d.clearance.from, d.clearance.to], [300, 60]);
  assert.ok(d.alignment.halfWidth > 0);
  assert.equal(d.northReference, 'true');
  assert.equal(d.officialCheckRequired, true);
  assert.match(d.warning, /official Starlink app/);
  assert.ok(d.explanation.length >= 2);
  assert.match(d.method, /profile/);
  assert.equal(d.isDemonstrationData, false);
});

test('states uncertainty with a basis', () => {
  const d = estimateDirection(ABERYSTWYTH);
  assert.equal(d.confidence.level, 'moderate');
  assert.match(d.confidence.label, /low for an exact bearing/);
  assert.ok(d.confidence.basis.some((b) => /not determinable/.test(b)));
  assert.ok(UK_NORTHERN_SKY_PROFILE.basis.every((b) => b.claim && b.evidence && b.strength));
});

test('includes the geostationary arc to the south', () => {
  const d = estimateDirection(ABERYSTWYTH);
  assert.equal(d.geoArc.azimuth, 180);
  assert.ok(d.geoArc.peakElevation > 29 && d.geoArc.peakElevation < 31);
  assert.ok(d.geoArc.horizon.east < 180 && d.geoArc.horizon.west > 180);
});

test('returns insufficient data without coordinates', () => {
  for (const loc of [null, undefined, {}, { lat: NaN, lon: 0 }, { lat: 200, lon: 0 }]) {
    const d = estimateDirection(loc);
    assert.equal(d.status, ESTIMATE_STATUS.INSUFFICIENT);
    assert.equal(d.confidence.level, 'none');
    assert.equal(d.centreAzimuth, undefined);
    assert.ok(d.reasons.length);
  }
});

test('refuses to estimate outside the UK profile', () => {
  for (const loc of [{ lat: 48.8566, lon: 2.3522 }, { lat: -33.86, lon: 151.2 }, { lat: 40.7, lon: -74 }, { lat: 64.1, lon: -21.9 }]) {
    const d = estimateDirection(loc);
    assert.equal(d.status, ESTIMATE_STATUS.INSUFFICIENT, JSON.stringify(loc));
    assert.match(d.reasons.join(' '), /outside/);
  }
  assert.ok(profileApplies(UK_NORTHERN_SKY_PROFILE, 60.15, -1.15)); // Lerwick
  assert.ok(profileApplies(UK_NORTHERN_SKY_PROFILE, 49.91, -6.31)); // Scilly
  assert.ok(profileApplies(UK_NORTHERN_SKY_PROFILE, 54.6, -5.93));  // Belfast
});

test('installer overrides are clamped and clearance never narrower than alignment', () => {
  const d = estimateDirection(ABERYSTWYTH, UK_NORTHERN_SKY_PROFILE, { alignmentHalfWidth: 40, clearanceHalfWidth: 10 });
  assert.equal(d.alignment.halfWidth, 40);
  assert.equal(d.clearance.halfWidth, 40);
  const e = estimateDirection(ABERYSTWYTH, UK_NORTHERN_SKY_PROFILE, { alignmentHalfWidth: 1 });
  assert.equal(e.alignment.halfWidth, 5);
});

test('flags approximate locations without changing the sky sector', () => {
  const d = estimateDirection({ ...ABERYSTWYTH, accuracy: LOCATION_ACCURACY.POSTCODE });
  assert.equal(d.status, ESTIMATE_STATUS.ESTIMATE);
  assert.ok(d.notes.some((n) => /approximate/.test(n)));
  assert.ok(!isPreciseLocation(LOCATION_ACCURACY.POSTCODE));
  assert.ok(isPreciseLocation(LOCATION_ACCURACY.INSTALLER));
});

test('demonstration profiles are labelled', () => {
  const demo = { ...UK_NORTHERN_SKY_PROFILE, id: 'demo', isDemonstrationData: true };
  assert.equal(estimateDirection(ABERYSTWYTH, demo).isDemonstrationData, true);
});

test('summarises recorded on-site bearings nearby only', () => {
  const jobs = [
    { lat: 52.42, lon: -4.08, onSite: { observedBearing: 350 } },
    { lat: 52.40, lon: -4.10, onSite: { observedBearing: 10 } },
    { lat: 52.41, lon: -4.07, onSite: { observedBearing: null } },
    { lat: 51.50, lon: -0.12, onSite: { observedBearing: 90 } }, // London, too far
  ];
  const s = summariseNearbyObservedBearings(jobs, ABERYSTWYTH.lat, ABERYSTWYTH.lon, 25);
  assert.equal(s.count, 2);
  assert.ok(Math.abs(((s.mean + 180) % 360) - 180) < 1e-6);
  assert.equal(summariseNearbyObservedBearings([], 52, -4).count, 0);
});

test('converts true to magnetic bearings with a supplied declination', () => {
  assert.equal(trueToMagnetic(0, 1.5), 358.5);
  assert.equal(trueToMagnetic(0, -2), 2);
  assert.equal(trueToMagnetic(10, 0), 10);
});
