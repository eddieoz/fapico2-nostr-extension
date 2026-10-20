// US-1747 — the NIP-44 decrypt payload is base64-decoded before framing.
// The page passes a base64 string (the NIP-44 v2 wire format); the worker
// must frame the DECODED bytes (0x02 ‖ nonce(32) ‖ ct ‖ mac(32)) for the
// device, not `new Uint8Array(payload)` — a string coerced to a length, 0
// for any non-numeric base64. The test drives the real createHandlers
// nip44_decrypt with a scripted device double that captures the arg it
// receives, and asserts the framed arg is peer(32) ‖ base64.decode(payload).

import test from 'node:test';
import assert from 'node:assert/strict';

import { base64 } from '@scure/base';
import { hexToBytes } from '@noble/hashes/utils.js';

import { createDeviceOwner } from '../src/worker/device.js';
import { createHandlers } from '../src/worker/handlers.js';
import { NOSTR_CMD, SW } from '../src/core/ctaphid.js';

const PEER = 'bb'.repeat(32); // 32-byte peer xpublic key, hex

function rig(decryptReply) {
  const seen = [];
  const transport = {
    vendor: async (cmd, idx, arg) => {
      seen.push({ cmd, idx, arg });
      return decryptReply;
    },
  };
  const device = createDeviceOwner({
    getGrantedDevice: async () => ({}),
    createTransport: () => transport,
    openTransport: async () => {},
  });
  const handlers = createHandlers({ device });
  return { handlers, seen };
}

const call = (handlers, method, args) =>
  handlers[method](args, {
    sender: { url: 'chrome-extension://x/popup.html' },
    trusted: true,
    requestId: 't',
  });

test('US-1747 the decrypt arg is peer(32) ‖ base64.decode(payload), not an empty frame', async () => {
  // 'aabbccdd' is non-numeric base64: new Uint8Array('aabbccdd') is length 0,
  // so the old framing sent peer-only (32 bytes). The decoded payload is 6
  // bytes, so the framed arg must be 38.
  const payload = 'aabbccdd';
  const decoded = base64.decode(payload);
  assert.ok(decoded.length > 0, 'the test payload decodes to non-empty bytes');
  const { handlers, seen } = rig({ sw: SW.OK, data: new Uint8Array([0x66, 0x69, 0x6e, 0x65]) });
  await call(handlers, 'nip44_decrypt', [PEER, payload]);
  assert.equal(seen.length, 1, 'exactly one device frame');
  assert.equal(seen[0].cmd, NOSTR_CMD.NIP44_DECRYPT);
  assert.equal(seen[0].arg.length, 32 + decoded.length, 'peer(32) ‖ decoded payload, not empty');
  assert.deepEqual([...seen[0].arg.slice(0, 32)], [...hexToBytes(PEER)], 'the peer is framed first');
  assert.deepEqual([...seen[0].arg.slice(32)], [...decoded], 'the payload is the base64-decoded bytes');
});

test('US-1747 an all-digit base64 payload is decoded, not zero-filled to its numeric value', async () => {
  // '1234' is valid base64 (decodes to 3 bytes) but new Uint8Array('1234')
  // is a zero-filled length-1234 array — the old framing's other failure mode.
  const payload = '1234';
  const decoded = base64.decode(payload);
  const { handlers, seen } = rig({ sw: SW.OK, data: new Uint8Array(0) });
  await call(handlers, 'nip44_decrypt', [PEER, payload]);
  assert.equal(seen[0].arg.length, 32 + decoded.length, 'decoded length, not the numeric coercion');
  assert.notEqual(seen[0].arg.length, 32 + 1234, 'not zero-filled to 1234');
});

test('US-1747 an invalid base64 payload is a typed signer error, not a raw throw', async () => {
  const { handlers } = rig({ sw: SW.OK, data: new Uint8Array(0) });
  const err = await call(handlers, 'nip44_decrypt', [PEER, '!!!not-base64!!!']).then(
    () => null,
    (e) => e,
  );
  assert.ok(err, 'an invalid payload rejects');
  assert.equal(err.code, 'NIP44_PAYLOAD_MALFORMED', 'the typed sentence, not a raw @scure/base message');
});
