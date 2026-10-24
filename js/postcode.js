// UK postcode validation and normalisation.
// Pattern follows the published UK format rules (area letters, district, sector, unit),
// including the GIR 0AA special case. Format validity does not prove the postcode exists:
// existence is checked by the geocoding provider.

const POSTCODE_RE =
  /^(GIR0AA|[A-PR-UWYZ](?:[0-9]{1,2}|[A-HK-Y][0-9]{1,2}|[0-9][A-HJKPS-UW]|[A-HK-Y][0-9][ABEHMNPRV-Y])[0-9][ABD-HJLNP-UW-Z]{2})$/;

const POSTCODE_IN_TEXT_RE =
  /\b(GIR ?0AA|[A-PR-UWYZ](?:[0-9]{1,2}|[A-HK-Y][0-9]{1,2}|[0-9][A-HJKPS-UW]|[A-HK-Y][0-9][ABEHMNPRV-Y]) ?[0-9][ABD-HJLNP-UW-Z]{2})\b/i;

const compact = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export function isValidPostcode(input) {
  return POSTCODE_RE.test(compact(input));
}

/** "sw1a1aa" → "SW1A 1AA". Returns null for invalid input. */
export function normalisePostcode(input) {
  const c = compact(input);
  if (!POSTCODE_RE.test(c)) return null;
  return `${c.slice(0, -3)} ${c.slice(-3)}`;
}

/** Finds a postcode inside free text such as "14 Orchard Close, AB12 3CD". */
export function extractPostcode(text) {
  const m = String(text ?? '').match(POSTCODE_IN_TEXT_RE);
  return m ? normalisePostcode(m[1]) : null;
}

/** Friendly reason for an invalid entry, or null when valid. */
export function postcodeProblem(input) {
  const c = compact(input);
  if (!c) return 'Enter a postcode or an address.';
  if (c.length < 5) return 'Too short for a full UK postcode, e.g. SW1A 1AA.';
  if (c.length > 7) return 'Too long for a UK postcode.';
  if (!/[0-9][A-Z]{2}$/.test(c)) return 'A UK postcode ends with a digit and two letters, e.g. 1AA.';
  if (!POSTCODE_RE.test(c)) return 'That is not a valid UK postcode format.';
  return null;
}
