// US-1673 — the extension test suite is the Phase 4 gate. The suite as a
// whole covers the seams (seam.test.js), the framing parser byte-exact
// against the CTAPHID spec Chromium implements (ctaphid.test.js), the
// device-absent and interrupted states (loudness.test.js, batch.test.js).
// What was missing until now is the cross-check: **the same event signed
// both ways verifies identically** — the board path and the software path,
// same key, same event, byte-identical result.

import test from 'node:test';
import assert from 'node:assert/strict';

import { schnorr } from '@noble/curves/secp256k1.js';
import { hexToBytes } from '@noble/hashes/utils.js';
import { verifyEvent } from 'nostr-tools';

import { FapicoSigner, SoftwareSigner } from '../src/core/seams.js';
import { MockDevice } from './mock_device.js';

test('US-1673 the same event signed both ways verifies identically', async () => {
  // The mock device's identity 0 holds exactly this scalar.
  const sk = hexToBytes('11'.repeat(32));
  const event = {
    kind: 1,
    content: 'cross-check: board and browser agree',
    tags: [['t', 'nostr']],
    created_at: 1700000000,
  };

  const hardware = await new FapicoSigner(new MockDevice()).signEvent(event);
  const software = await new SoftwareSigner(sk).signEvent(event);

  // Same event, same identity, same NIP-01 id.
  assert.equal(hardware.id, software.id, 'same NIP-01 id');
  assert.equal(hardware.pubkey, software.pubkey, 'same identity');

  // The signatures are not byte-identical — BIP-340's aux randomness
  // differs per signer and nostr-tools does not pin it — but each one
  // verifies, independently, as a signature on the SAME id by the SAME
  // key. That is "verifies identically": both paths' output is valid for
  // the same (id, pubkey) pair, checked against the key bytes themselves.
  const msgHash = hexToBytes(hardware.id);
  const pubX = hexToBytes(hardware.pubkey);
  assert.ok(verifyEvent(hardware), 'ground truth accepts the board signature');
  assert.ok(verifyEvent(software), 'ground truth accepts the software signature');
  assert.ok(schnorr.verify(hexToBytes(hardware.sig), msgHash, pubX));
  assert.ok(schnorr.verify(hexToBytes(software.sig), msgHash, pubX));
});
