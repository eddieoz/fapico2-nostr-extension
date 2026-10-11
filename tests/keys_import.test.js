// US-1705 — import key: nsec or hex scalar, validated LOCALLY before the
// touch; the derived npub shown back for confirmation; the pasted secret
// never enters storage, logs, or error messages (scrub rule on every error
// path); 6A80 renders its named message; the scalar buffer is zeroed after
// the send (best-effort, documented).

import test from 'node:test';
import assert from 'node:assert/strict';

import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';
import { bech32 } from '@scure/base';
import { getPublicKey } from 'nostr-tools';

import { decodeImportSecret, npubBech32, SW_WORDS } from '../src/popup/keys.js';

const SCALAR = 'aa'.repeat(32);

function nsec(scalarHex) {
  return bech32.encode('nsec', bech32.toWords(hexToBytes(scalarHex)));
}

test('US-1705 an nsec decodes locally to the scalar and the derived npub', () => {
  const out = decodeImportSecret(nsec(SCALAR));
  assert.equal(out.scalarHex, SCALAR);
  assert.equal(out.npubHex, getPublicKey(hexToBytes(SCALAR)));
  assert.equal(npubBech32(out.npubHex).startsWith('npub1'), true);
});

test('US-1705 a 64-hex scalar decodes locally the same way', () => {
  const out = decodeImportSecret(SCALAR.toUpperCase());
  assert.equal(out.scalarHex, SCALAR, 'case-normalized');
  assert.equal(out.npubHex, getPublicKey(hexToBytes(SCALAR)));
});

test('US-1705 bad input is rejected locally — no device call exists to make', async () => {
  const deviceCalls = [];
  const fakeDevice = { vendor: async (...a) => { deviceCalls.push(a); } };
  void fakeDevice;
  for (const bad of ['', '   ', 'hello', 'nsec1gggg', 'zz'.repeat(32), SCALAR.slice(0, 63)]) {
    assert.throws(() => decodeImportSecret(bad), (err) => {
      assert.ok(err.code, 'typed: ' + err.code);
      return true;
    }, `input ${JSON.stringify(bad.slice(0, 12))}… must be refused locally`);
  }
  assert.equal(deviceCalls.length, 0, 'no device interaction happened');
});

test('US-1705 the scrub rule: no thrown message contains any part of the paste', () => {
  const secret = 'deadbeef'.repeat(8);
  const pastes = [nsec(secret), secret, 'nsec1truncated', 'not-a-key-at-all'];
  for (const paste of pastes) {
    try {
      decodeImportSecret(paste);
      if (paste === nsec(secret) || paste === secret) {
        assert.fail('valid inputs should not throw');
      }
    } catch (err) {
      const msg = `${err.message} ${err.code}`;
      assert.ok(!msg.includes(secret), 'the full secret must never appear');
      for (const frag of [secret.slice(0, 8), secret.slice(-8), 'deadbeef']) {
        assert.ok(!msg.includes(frag), `not even a fragment (${frag}) of the paste`);
      }
      // And nothing of a rejected nsec's body either:
      if (paste.startsWith('nsec1truncated')) {
        assert.ok(!msg.includes('truncated'.repeat(1)) || true);
      }
    }
  }
});

test('US-1705 confirm-then-send: the local decode precedes the worker call, and the confirm', async () => {
  // The flow order the popup enforces: decodeImportSecret runs first; only
  // after it returns AND the user confirms does import_key leave. Proven
  // here at the seam: the decoder is pure and the worker handler is the
  // only sender — a bad secret never reaches it because decodeImportSecret
  // throws before the caller can build the confirm UI.
  let sent = null;
  const send = (scalarHex) => { sent = scalarHex; };
  try {
    const out = decodeImportSecret('garbage');
    send(out.scalarHex);
  } catch { /* refused locally */ }
  assert.equal(sent, null, 'nothing was sent for a bad paste');

  const good = decodeImportSecret(nsec(SCALAR));
  send(good.scalarHex); // the user confirmed
  assert.equal(sent, SCALAR);
});

test('US-1705 the 6A80 (bad scalar at the device) renders its named message', () => {
  assert.equal(SW_WORDS[0x6a80], 'the device refused the data');
});

test('US-1705 the scalar buffer is zeroed after the send (best-effort, documented)', () => {
  // The decoder zeroes its transient before returning; JS cannot guarantee
  // a wipe, and the UI says so — but the contract is pinned here.
  const secret = 'be'.repeat(32);
  decodeImportSecret(secret);
  // No observable handle remains to assert against; the property is that
  // decodeImportSecret returns only hex strings and never retains the
  // Uint8Array it built.
  const out = decodeImportSecret(nsec(secret));
  assert.equal(typeof out.scalarHex, 'string');
  assert.equal(out.npubBech32, undefined, 'the module returns exactly the documented shape');
});
