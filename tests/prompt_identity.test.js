// US-1710 — the prompt's identity line: which key will answer. Graded
// degradation: keys known + slot occupied → the npub line; keys known +
// slot unoccupied → the no-active-key line; only the slot known → the
// slot-only line; even the slot unknown → null (omit). NEVER an error.

import test from 'node:test';
import assert from 'node:assert/strict';

import { identityLine } from '../src/prompt/identity.js';

const NPUB = '3bf0c101'.padEnd(64, '0');

test('US-1710 the line names the npub and the slot when both are known', () => {
  assert.match(identityLine(1, [{ idx: 1, pubkey: NPUB }]), /^with npub1.*\(slot 1\)$/);
});

test('US-1710 keys unknown (fetch failed/timed out) degrades to slot-only', () => {
  assert.equal(identityLine(2, null), 'with the key in slot 2');
});

test('US-1710 an unoccupied active slot says so — approving into a guaranteed refusal is never silent', () => {
  assert.equal(identityLine(1, []), 'no active key is set on the device');
});

test('US-1710 an unknown slot omits the line (null)', () => {
  assert.equal(identityLine(undefined, [{ idx: 0, pubkey: NPUB }]), null);
  assert.equal(identityLine(9, []), null);
});
