import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normaliseBearing, angularDifference, isBearingInSector, sectorBounds, compassPoint, formatBearing,
  distanceMetres, initialBearing, destinationPoint, sectorPolygon, geoArcPeakElevation, geoArcHorizonAzimuths,
  circularStats, pointInPolygon, isValidLatLon, assertLatLon,
} from '../js/geo.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b} ±${tol}, got ${a}`);

test('normalises bearings into [0, 360)', () => {
  assert.equal(normaliseBearing(0), 0);
  assert.equal(normaliseBearing(360), 0);
  assert.equal(normaliseBearing(-10), 350);
  assert.equal(normaliseBearing(725), 5);
  assert.equal(normaliseBearing(-720), 0);
  assert.ok(!Object.is(normaliseBearing(-360), -0));
  assert.throws(() => normaliseBearing(NaN), TypeError);
});

test('signed angular difference takes the short way round', () => {
  assert.equal(angularDifference(350, 10), 20);
  assert.equal(angularDifference(10, 350), -20);
  assert.equal(angularDifference(0, 180), 180);
  assert.equal(angularDifference(90, 90), 0);
});

test('sector membership across north', () => {
  assert.ok(isBearingInSector(350, 0, 25));
  assert.ok(isBearingInSector(25, 0, 25));
  assert.ok(isBearingInSector(335, 0, 25));
  assert.ok(!isBearingInSector(334, 0, 25));
  assert.ok(!isBearingInSector(180, 0, 25));
  assert.ok(isBearingInSector(123, 0, 180));
  assert.deepEqual(sectorBounds(0, 25), { from: 335, to: 25 });
});

test('compass labels and formatting', () => {
  assert.equal(compassPoint(0), 'N');
  assert.equal(compassPoint(359), 'N');
  assert.equal(compassPoint(337.5), 'NNW');
  assert.equal(compassPoint(22.5), 'NNE');
  assert.equal(compassPoint(180), 'S');
  assert.equal(formatBearing(5), '005°');
  assert.equal(formatBearing(359.6), '000°');
});

test('coordinate validation', () => {
  assert.ok(isValidLatLon(51.5, -0.12));
  assert.ok(!isValidLatLon(91, 0));
  assert.ok(!isValidLatLon(0, 181));
  assert.ok(!isValidLatLon(NaN, 0));
  assert.ok(!isValidLatLon('51', 0));
  assert.throws(() => assertLatLon(100, 0), RangeError);
});

test('distance and bearing between UK cities', () => {
  // London (Charing Cross) to Edinburgh (Waverley): ~534 km, initial bearing ~340°
  near(distanceMetres(51.5074, -0.1278, 55.9533, -3.1883) / 1000, 534, 3, 'distance');
  near(initialBearing(51.5074, -0.1278, 55.9533, -3.1883), 340, 2, 'bearing');
  near(initialBearing(52, 0, 53, 0), 0, 1e-9, 'due north');
  near(initialBearing(52, 0, 51, 0), 180, 1e-9, 'due south');
});

test('destination point round-trips with distance and bearing', () => {
  for (const b of [0, 45, 135, 225, 315, 359]) {
    const p = destinationPoint(54.0, -2.0, b, 80);
    near(distanceMetres(54.0, -2.0, p.lat, p.lon), 80, 0.01, `distance @${b}`);
    near(Math.abs(angularDifference(initialBearing(54.0, -2.0, p.lat, p.lon), b)), 0, 0.01, `bearing @${b}`);
  }
});

test('sector polygon geometry', () => {
  const ring = sectorPolygon(52.4, -4.08, 0, 25, 70);
  assert.deepEqual(ring[0], { lat: 52.4, lon: -4.08 });
  assert.deepEqual(ring.at(-1), { lat: 52.4, lon: -4.08 });
  const arc = ring.slice(1, -1);
  assert.ok(arc.length >= 17);
  for (const p of arc) {
    near(distanceMetres(52.4, -4.08, p.lat, p.lon), 70, 0.01, 'arc radius');
    assert.ok(isBearingInSector(initialBearing(52.4, -4.08, p.lat, p.lon), 0, 25.001));
  }
  near(initialBearing(52.4, -4.08, arc[0].lat, arc[0].lon), 335, 0.01, 'first edge');
  near(initialBearing(52.4, -4.08, arc.at(-1).lat, arc.at(-1).lon), 25, 0.01, 'last edge');
  assert.throws(() => sectorPolygon(52, 0, 0, 0, 70), RangeError);
  assert.throws(() => sectorPolygon(52, 0, 0, 20, -1), RangeError);
  assert.throws(() => sectorPolygon(95, 0, 0, 20, 10), RangeError);
});

test('geostationary arc elevation and horizon crossings', () => {
  near(geoArcPeakElevation(0), 90, 1e-9, 'equator');
  near(geoArcPeakElevation(52.4), 30.1, 0.2, 'mid-Wales');
  near(geoArcPeakElevation(60.15), 21.6, 0.3, 'Shetland');
  assert.ok(geoArcPeakElevation(50) > geoArcPeakElevation(58));
  assert.equal(geoArcPeakElevation(85), null);
  const h = geoArcHorizonAzimuths(52.4);
  near(h.east + h.west, 360, 1e-9, 'symmetric about south');
  near(h.east, 101.5, 1, 'east crossing');
  assert.equal(geoArcHorizonAzimuths(85), null);
});

test('circular statistics handle wrap-around', () => {
  const s = circularStats([350, 10]);
  near(Math.abs(angularDifference(s.mean, 0)), 0, 1e-9);
  near(s.spread, 10, 0.2);
  assert.equal(circularStats([]), null);
  assert.equal(circularStats([0, 180]).mean, null);
});

test('point in polygon', () => {
  const sq = [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }, { lat: 1, lon: 1 }, { lat: 1, lon: 0 }, { lat: 0, lon: 0 }];
  assert.ok(pointInPolygon(0.5, 0.5, sq));
  assert.ok(!pointInPolygon(1.5, 0.5, sq));
});
