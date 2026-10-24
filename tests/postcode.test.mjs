import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidPostcode, normalisePostcode, extractPostcode, postcodeProblem } from '../js/postcode.js';

test('accepts every UK postcode format', () => {
  for (const pc of ['M1 1AE', 'B33 8TH', 'CR2 6XH', 'DN55 1PT', 'W1A 0AX', 'EC1A 1BB', 'SW1A 1AA', 'GIR 0AA', 'BT1 5GS', 'ZE1 0AA', 'TR21 0HE']) {
    assert.ok(isValidPostcode(pc), pc);
  }
});

test('is case- and spacing-insensitive', () => {
  assert.equal(normalisePostcode('sw1a1aa'), 'SW1A 1AA');
  assert.equal(normalisePostcode('  ec1a   1bb '), 'EC1A 1BB');
  assert.equal(normalisePostcode('m11ae'), 'M1 1AE');
});

test('rejects invalid formats', () => {
  for (const pc of ['', 'SW1A', 'Q1 1AA', 'SW1A 1CA', 'AB12 3CD', 'AB12 3DEX', '12345', 'SW1A 1A', 'VX1 1AA', 'hello']) {
    assert.equal(isValidPostcode(pc), false, pc);
    assert.equal(normalisePostcode(pc), null, pc);
  }
});

test('explains what is wrong', () => {
  assert.match(postcodeProblem(''), /Enter/);
  assert.match(postcodeProblem('SW1'), /short/);
  assert.match(postcodeProblem('SW1A 1A9'), /ends with/);
  assert.equal(postcodeProblem('SW1A 1AA'), null);
});

test('extracts a postcode from an address', () => {
  assert.equal(extractPostcode('10 Downing Street, London SW1A 2AA'), 'SW1A 2AA');
  assert.equal(extractPostcode('Rose Cottage, ab12 3de'), 'AB12 3DE');
  assert.equal(extractPostcode('No postcode here'), null);
});
