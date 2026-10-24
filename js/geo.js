// Geodesy and bearing helpers. Pure functions, no DOM; unit tested in tests/geo.test.mjs.

export const EARTH_RADIUS_M = 6371008.8; // IUGG mean radius
const WGS84_EQUATORIAL_KM = 6378.137;
const GEO_ORBIT_RADIUS_KM = 42164.0; // geostationary orbit radius from Earth's centre

export const toRad = (d) => (d * Math.PI) / 180;
export const toDeg = (r) => (r * 180) / Math.PI;

/** Normalise any bearing to the range [0, 360). */
export function normaliseBearing(deg) {
  if (!Number.isFinite(deg)) throw new TypeError('Bearing must be a finite number');
  const b = deg % 360;
  return b < 0 ? b + 360 : b === 0 ? 0 : b; // avoids -0
}

/** Signed smallest difference from a to b, in (-180, 180]. */
export function angularDifference(a, b) {
  let d = normaliseBearing(b) - normaliseBearing(a);
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/** True when bearing lies within ±halfWidth of centre (inclusive). */
export function isBearingInSector(bearing, centre, halfWidth) {
  if (halfWidth >= 180) return true;
  return Math.abs(angularDifference(centre, bearing)) <= halfWidth + 1e-9;
}

export function sectorBounds(centre, halfWidth) {
  return { from: normaliseBearing(centre - halfWidth), to: normaliseBearing(centre + halfWidth) };
}

const POINTS_16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export function compassPoint(bearing) {
  return POINTS_16[Math.round(normaliseBearing(bearing) / 22.5) % 16];
}

export function formatBearing(bearing) {
  return `${String(Math.round(normaliseBearing(bearing)) % 360).padStart(3, '0')}°`;
}

export function isValidLatLon(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

export function assertLatLon(lat, lon) {
  if (!isValidLatLon(lat, lon)) throw new RangeError(`Invalid coordinates: ${lat}, ${lon}`);
}

/** Great-circle distance in metres. */
export function distanceMetres(lat1, lon1, lat2, lon2) {
  const φ1 = toRad(lat1), φ2 = toRad(lat2);
  const dφ = toRad(lat2 - lat1), dλ = toRad(lon2 - lon1);
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Initial great-circle bearing (true) from point 1 to point 2. */
export function initialBearing(lat1, lon1, lat2, lon2) {
  const φ1 = toRad(lat1), φ2 = toRad(lat2), dλ = toRad(lon2 - lon1);
  const y = Math.sin(dλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ);
  return normaliseBearing(toDeg(Math.atan2(y, x)));
}

/** Point reached travelling `distance` metres from a start point on `bearing`. */
export function destinationPoint(lat, lon, bearing, distance) {
  const δ = distance / EARTH_RADIUS_M, θ = toRad(bearing);
  const φ1 = toRad(lat), λ1 = toRad(lon);
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return { lat: toDeg(φ2), lon: ((toDeg(λ2) + 540) % 360) - 180 };
}

/**
 * Fan polygon (closed ring of {lat, lon}) from the apex out to `radius` metres,
 * spanning centre ± halfWidth. Handles sectors that cross north (e.g. 335°–025°).
 */
export function sectorPolygon(lat, lon, centre, halfWidth, radius, stepDeg = 3) {
  assertLatLon(lat, lon);
  if (!(radius > 0)) throw new RangeError('Radius must be positive');
  if (!(halfWidth > 0)) throw new RangeError('Half-width must be positive');
  const hw = Math.min(halfWidth, 180);
  const steps = Math.max(2, Math.ceil((2 * hw) / stepDeg));
  const ring = [{ lat, lon }];
  for (let i = 0; i <= steps; i++) {
    const b = normaliseBearing(centre - hw + (2 * hw * i) / steps);
    ring.push(destinationPoint(lat, lon, b, radius));
  }
  ring.push({ lat, lon });
  return ring;
}

/**
 * Elevation (degrees above the horizon) of the geostationary arc where it crosses
 * the observer's meridian (due south in the northern hemisphere). Exact spherical
 * geometry; returns null where the arc is below the horizon (|lat| > ~81.3°).
 */
export function geoArcPeakElevation(lat) {
  const φ = toRad(Math.abs(lat));
  const k = WGS84_EQUATORIAL_KM / GEO_ORBIT_RADIUS_KM;
  if (Math.cos(φ) <= k) return null;
  return toDeg(Math.atan2(Math.cos(φ) - k, Math.sin(φ)));
}

/**
 * Azimuths where the geostationary arc meets the horizon, as {east, west}
 * (e.g. ~101° and ~259° at 52°N). Null where the arc is not visible.
 */
export function geoArcHorizonAzimuths(lat) {
  const φ = toRad(Math.abs(lat));
  const k = WGS84_EQUATORIAL_KM / GEO_ORBIT_RADIUS_KM;
  if (Math.cos(φ) <= k) return null;
  const dλ = Math.acos(k / Math.cos(φ)); // sub-satellite longitude offset at zero elevation
  const fromMeridian = toDeg(Math.atan2(Math.tan(dλ), Math.sin(φ)));
  return lat >= 0
    ? { east: normaliseBearing(180 - fromMeridian), west: normaliseBearing(180 + fromMeridian) }
    : { east: normaliseBearing(fromMeridian), west: normaliseBearing(-fromMeridian) };
}

/** Local east/north offset in metres of point 2 relative to point 1 (equirectangular; fine < 1 km). */
export function localOffsetMetres(lat1, lon1, lat2, lon2) {
  const x = toRad(lon2 - lon1) * Math.cos(toRad((lat1 + lat2) / 2)) * EARTH_RADIUS_M;
  const y = toRad(lat2 - lat1) * EARTH_RADIUS_M;
  return { x, y };
}

/** Circular mean and spread of bearings (degrees). Returns null for an empty list. */
export function circularStats(bearings) {
  if (!bearings.length) return null;
  let s = 0, c = 0;
  for (const b of bearings) { s += Math.sin(toRad(b)); c += Math.cos(toRad(b)); }
  s /= bearings.length; c /= bearings.length;
  const r = Math.hypot(s, c);
  const mean = r < 1e-9 ? null : normaliseBearing(toDeg(Math.atan2(s, c)));
  const spread = r < 1e-9 ? 180 : Math.min(180, toDeg(Math.sqrt(-2 * Math.log(r)))); // circular std dev
  return { mean, spread, resultantLength: r, n: bearings.length };
}

/** Ray-casting point-in-polygon on lat/lon ring (small areas). */
export function pointInPolygon(lat, lon, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.lat > lat) !== (b.lat > lat) && lon < ((b.lon - a.lon) * (lat - a.lat)) / (b.lat - a.lat) + a.lon) inside = !inside;
  }
  return inside;
}
