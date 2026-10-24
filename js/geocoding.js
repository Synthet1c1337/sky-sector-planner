// Geocoding behind a provider interface. Each provider exposes:
//   lookupPostcode(postcode)              -> PlaceResult            (optional)
//   searchAddress(query, {postcode})      -> PlaceResult[]          (optional)
// PlaceResult: { label, postcode, lat, lon, accuracy, source, attribution }
// `fetchImpl` is injected so tests never touch the network.

import { normalisePostcode, extractPostcode, postcodeProblem } from './postcode.js';
import { isValidLatLon } from './geo.js';
import { LOCATION_ACCURACY } from './direction.js';

export class GeocodingError extends Error {
  /** @param {'invalid-input'|'not-found'|'network'|'rate-limited'|'bad-response'|'timeout'} code */
  constructor(code, message, cause) { super(message); this.name = 'GeocodingError'; this.code = code; this.cause = cause; }
}

async function requestJson(fetchImpl, url, { timeoutMs = 10000, headers = {} } = {}) {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  let res;
  try {
    res = await fetchImpl(url, { headers: { Accept: 'application/json', ...headers }, signal: ctrl?.signal });
  } catch (err) {
    if (err?.name === 'AbortError') throw new GeocodingError('timeout', 'The address service took too long to answer. Check your signal and try again.', err);
    throw new GeocodingError('network', 'Could not reach the address service. Check your connection and try again.', err);
  } finally { if (timer) clearTimeout(timer); }
  if (res.status === 404) return { notFound: true };
  if (res.status === 429) throw new GeocodingError('rate-limited', 'The address service is limiting requests. Wait a minute and try again.');
  if (!res.ok) throw new GeocodingError('bad-response', `The address service returned an error (${res.status}).`);
  try { return { body: await res.json() }; } catch (err) {
    throw new GeocodingError('bad-response', 'The address service sent an unreadable response.', err);
  }
}

/** postcodes.io: free, open data (ONS Postcode Directory / OS Open data). Centroids only. */
export class PostcodesIoProvider {
  constructor({ fetchImpl = globalThis.fetch?.bind(globalThis), baseUrl = 'https://api.postcodes.io' } = {}) {
    this.fetch = fetchImpl; this.baseUrl = baseUrl; this.id = 'postcodes.io';
  }
  async lookupPostcode(postcode) {
    const pc = normalisePostcode(postcode);
    if (!pc) throw new GeocodingError('invalid-input', postcodeProblem(postcode) ?? 'Invalid postcode.');
    const r = await requestJson(this.fetch, `${this.baseUrl}/postcodes/${encodeURIComponent(pc.replace(' ', ''))}`);
    if (r.notFound) throw new GeocodingError('not-found', `${pc} was not found. It may be new, terminated or mistyped.`);
    const p = r.body?.result;
    if (!p || !isValidLatLon(p.latitude, p.longitude)) {
      throw new GeocodingError('bad-response', `${pc} exists but has no coordinates in the open postcode data.`);
    }
    return {
      label: `Postcode centre, ${p.postcode}`,
      postcode: p.postcode,
      lat: p.latitude,
      lon: p.longitude,
      accuracy: LOCATION_ACCURACY.POSTCODE,
      locality: [p.admin_ward, p.admin_district].filter(Boolean).join(', '),
      source: 'postcodes.io',
      attribution: 'Contains OS data © Crown copyright and database right; Royal Mail data © Royal Mail copyright and database right; ONS data © Crown copyright.',
    };
  }
}

const HOUSE_TYPES = new Set(['house', 'building', 'residential', 'detached', 'semidetached_house', 'terrace', 'bungalow', 'farm', 'farmhouse', 'apartments', 'yes']);

/** Nominatim (OpenStreetMap). Usage policy: ≤1 request/second, no autocomplete, identify the app. */
export class NominatimProvider {
  constructor({ fetchImpl = globalThis.fetch?.bind(globalThis), baseUrl = 'https://nominatim.openstreetmap.org', email = '', minIntervalMs = 1100, now = () => Date.now() } = {}) {
    this.fetch = fetchImpl; this.baseUrl = baseUrl; this.email = email; this.id = 'nominatim';
    this.minIntervalMs = minIntervalMs; this.now = now; this.lastRequest = 0;
  }
  async searchAddress(query, { postcode } = {}) {
    const q = String(query ?? '').trim();
    if (q.length < 3) throw new GeocodingError('invalid-input', 'Enter more of the address.');
    const wait = this.lastRequest + this.minIntervalMs - this.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastRequest = this.now();
    const params = new URLSearchParams({ q, format: 'jsonv2', addressdetails: '1', countrycodes: 'gb', limit: '8' });
    if (this.email) params.set('email', this.email);
    const r = await requestJson(this.fetch, `${this.baseUrl}/search?${params}`);
    if (r.notFound || !Array.isArray(r.body)) return [];
    const wantPc = postcode ? normalisePostcode(postcode) : null;
    return r.body
      .map((item) => {
        const lat = Number(item.lat), lon = Number(item.lon);
        if (!isValidLatLon(lat, lon)) return null;
        const a = item.address ?? {};
        const pc = normalisePostcode(a.postcode) ?? null;
        const isAddress = Boolean(a.house_number || a.house_name) || HOUSE_TYPES.has(item.type) && item.category === 'building' || item.addresstype === 'building' || item.addresstype === 'house';
        const isStreet = item.addresstype === 'road' || item.category === 'highway';
        return {
          label: item.display_name,
          postcode: pc,
          lat, lon,
          accuracy: isAddress ? LOCATION_ACCURACY.ADDRESS : isStreet ? LOCATION_ACCURACY.STREET : LOCATION_ACCURACY.AREA,
          source: 'Nominatim (OpenStreetMap)',
          attribution: '© OpenStreetMap contributors (ODbL)',
          postcodeMismatch: Boolean(wantPc && pc && pc !== wantPc),
        };
      })
      .filter(Boolean);
  }
}

/**
 * Combines providers into the app's search behaviour:
 *  - a bare postcode → postcode centroid, plus any address matches if a house number/name is given
 *  - free text       → address search (postcode inside the text is used for checking)
 * Returns { results, warnings }. Address matches first; the centroid is always last and labelled.
 */
export class GeocodingService {
  constructor({ postcodeProvider, addressProvider }) {
    this.postcodeProvider = postcodeProvider; this.addressProvider = addressProvider;
  }

  async search(rawQuery, { houseNameOrNumber = '' } = {}) {
    const query = String(rawQuery ?? '').trim();
    const house = String(houseNameOrNumber ?? '').trim();
    if (!query) throw new GeocodingError('invalid-input', 'Enter a postcode or an address.');
    const bare = normalisePostcode(query);
    const postcode = bare ?? extractPostcode(query);
    const warnings = [];
    const results = [];

    if (!bare && /^[A-Z]{1,2}[0-9][A-Z0-9]?\s*[0-9]?[A-Z]{0,2}$/i.test(query.replace(/\s+/g, ' '))) {
      // Looks like a postcode but is not valid.
      throw new GeocodingError('invalid-input', postcodeProblem(query) ?? 'That is not a valid UK postcode.');
    }

    let centroid = null;
    let centroidError = null;
    if (postcode && this.postcodeProvider) {
      try { centroid = await this.postcodeProvider.lookupPostcode(postcode); } catch (e) { centroidError = e; }
    }
    if (centroidError?.code === 'not-found' && bare) throw centroidError;

    const addressQuery = bare ? (house ? `${house}, ${postcode}` : null) : (house ? `${house}, ${query}` : query);
    let addressError = null;
    if (addressQuery && this.addressProvider) {
      try {
        const found = await this.addressProvider.searchAddress(addressQuery, { postcode });
        for (const r of found) {
          if (r.postcodeMismatch) continue; // a match in a different postcode is not this customer
          results.push(r);
        }
        if (found.some((r) => r.postcodeMismatch)) warnings.push('Some matches were in a different postcode and were hidden.');
      } catch (e) { addressError = e; }
    }

    if (centroid) results.push(centroid);

    if (!results.length) {
      const err = addressError ?? centroidError;
      if (err && err.code !== 'not-found') throw err;
      throw new GeocodingError('not-found', bare
        ? `No address match for "${house}" in ${postcode}. Use the postcode centre and place the roof on the map.`
        : 'No matching UK address found. Try the postcode on its own.');
    }
    if (addressError) warnings.push(`Address search failed (${addressError.message}) Showing postcode centre only.`);
    if (addressQuery && !results.some((r) => r.accuracy === LOCATION_ACCURACY.ADDRESS)) {
      warnings.push('No exact address point found. Place the pin on the roof yourself before relying on obstruction checks.');
    }
    if (results.filter((r) => r.accuracy === LOCATION_ACCURACY.ADDRESS).length > 1) {
      warnings.push('Several properties match. Pick the right one and check it against the map.');
    }
    return { results, warnings };
  }
}
