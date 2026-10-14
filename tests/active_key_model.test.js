// US-1710 — the active-key model: the one render source for the popup's
// strip and radios. The stored slot is never trusted blindly — it is
// validated against device truth (the keys list); an unoccupied stored
// slot renders as nothing selected plus the actionable strip line.

import test from 'node:test';
import assert from 'node:assert/strict';

import { hexToBytes } from '@noble/hashes/utils.js';
import { getPublicKey } from 'nostr-tools';

import { activeKeyModel } from '../src/popup/keys.js';

const K0 = { idx: 0, flags: 0, pubkey: getPublicKey(hexToBytes('11'.repeat(32))), label: 'main' };
const K3 = { idx: 3, flags: 0, pubkey: getPublicKey(hexToBytes('22'.repeat(32))), label: '' };

test('US-1710 the model picks the active row from device truth', () => {
  const m = activeKeyModel([K0, K3], 3);
  assert.equal(m.active.idx, 3);
  assert.match(m.strip, /npub1.*slot 3/);
});

test('US-1710 an unoccupied stored slot renders as nothing selected plus the hint', () => {
  const m = activeKeyModel([K0, K3], 5);
  assert.equal(m.active, null);
  assert.equal(m.strip, 'no active key yet');
});

test('US-1716 an empty device renders the zero-key line without demanding a pick', () => {
  const m = activeKeyModel([], 0);
  assert.equal(m.active, null);
  assert.equal(m.strip, 'no active key yet');
  // it names the state, never asks the user to pick something that does not exist
  assert.doesNotMatch(m.strip, /pick/i);
});
