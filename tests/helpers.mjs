// Mock fetch: routes are [predicate(url, init), responder] pairs. No network is touched.
export function mockFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    for (const [match, respond] of routes) {
      if (match(String(url), init)) return respond(String(url), init);
    }
    throw new TypeError('Failed to fetch (no mock route)');
  };
  fn.calls = calls;
  return fn;
}
export const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
export const badJson = (status = 200) => ({ ok: true, status, json: async () => { throw new SyntaxError('Unexpected token <'); } });
export const networkDown = () => { throw new TypeError('Failed to fetch'); };

export const POSTCODES_IO_OK = {
  status: 200,
  result: { postcode: 'SY23 1DE', latitude: 52.41543, longitude: -4.08291, admin_ward: 'Aberystwyth Central', admin_district: 'Ceredigion' },
};
export const NOMINATIM_TWO_HOUSES = [
  { lat: '52.4157', lon: '-4.0825', display_name: '14, Example Street, Aberystwyth, SY23 1DE, United Kingdom', category: 'place', type: 'house', addresstype: 'place', address: { house_number: '14', road: 'Example Street', postcode: 'SY23 1DE' } },
  { lat: '52.4158', lon: '-4.0826', display_name: '14A, Example Street, Aberystwyth, SY23 1DE, United Kingdom', category: 'place', type: 'house', addresstype: 'place', address: { house_number: '14A', road: 'Example Street', postcode: 'SY23 1DE' } },
  { lat: '51.48', lon: '-3.18', display_name: '14, Example Street, Cardiff, CF10 1AA, United Kingdom', category: 'place', type: 'house', addresstype: 'place', address: { house_number: '14', postcode: 'CF10 1AA' } },
];
