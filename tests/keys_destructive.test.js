// US-1706 — delete and label: loud confirms for destructive and
// identity-setting ops. Delete success requires the echoed npub to MATCH
// the requested slot's npub (a mismatch is a typed store-fault, never a
// green checkmark); Set Label previews the exact bytes sent and enforces
// the 32-BYTE UTF-8 limit locally; the touch-timeout path renders typed.

import test from 'node:test';
import assert from 'node:assert/strict';

import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';
import { getPublicKey } from 'nostr-tools';

import { createDeviceOwner } from '../src/worker/device.js';
import { createHandlers } from '../src/worker/handlers.js';
import { validateLabel, SW_WORDS } from '../src/popup/keys.js';
import { SW } from '../src/core/ctaphid.js';

const SLOT1_NPUB = hexToBytes(getPublicKey(hexToBytes('44'.repeat(32))));

function rig(deleteReply) {
  const vendorCalls = [];
  const transport = {
    vendor: async (cmd, idx, arg) => {
      vendorCalls.push({ cmd, idx, arg });
      return typeof deleteReply === 'function' ? deleteReply(idx, arg) : deleteReply;
    },
  };
  const device = createDeviceOwner({
    getGrantedDevice: async () => ({}),
    createTransport: () => transport,
    openTransport: async () => {},
  });
  return { handlers: createHandlers({ device }), vendorCalls };
}

const call = (handlers, method, args) =>
  handlers[method](args, { sender: { url: 'chrome-extension://x/popup.html' }, trusted: true, requestId: 't' });

test('US-1706 delete success: 9000 + the echoed npub matches the requested slot', async () => {
  const { handlers, vendorCalls } = rig({ sw: SW.OK, data: SLOT1_NPUB });
  const res = await call(handlers, 'delete_key', [1, bytesToHex(SLOT1_NPUB)]);
  assert.equal(res.npub, bytesToHex(SLOT1_NPUB));
  assert.equal(vendorCalls[0].idx, 1, 'DELETE_KEY addressed the requested slot');
});

test('US-1706 a mismatched echo is a typed store-fault, never a green checkmark', async () => {
  const otherNpub = hexToBytes(getPublicKey(hexToBytes('55'.repeat(32))));
  const { handlers } = rig({ sw: SW.OK, data: otherNpub });
  const err = await call(handlers, 'delete_key', [1, bytesToHex(SLOT1_NPUB)]).then(() => null, (e) => e);
  assert.equal(err.code, 'STORE_FAULT');
  assert.equal(err.name, 'SignerError');
  assert.match(err.message, /different identity|store fault/);
});

test('US-1706 delete without an expected npub still returns the echo (worker-level contract)', async () => {
  const { handlers } = rig({ sw: SW.OK, data: SLOT1_NPUB });
  const res = await call(handlers, 'delete_key', [1]);
  assert.equal(res.npub, bytesToHex(SLOT1_NPUB));
});

test('US-1706 the delete touch-timeout path is typed 6985', async () => {
  const { handlers } = rig({ sw: SW.CONDITIONS_NOT_SATISFIED, data: new Uint8Array(0) });
  const err = await call(handlers, 'delete_key', [1, bytesToHex(SLOT1_NPUB)]).then(() => null, (e) => e);
  assert.equal(err.sw, 0x6985);
  assert.equal(SW_WORDS[0x6985], 'touch timed out — the device asked for a touch and none came');
});

test('US-1706 label: 32 ASCII bytes is legal, 33 is refused locally (byte length, not char count)', () => {
  const ascii32 = 'a'.repeat(32);
  assert.equal(validateLabel(ascii32).length, 32);
  assert.throws(() => validateLabel('a'.repeat(33)), (err) => err.code === 'LABEL_TOO_LONG');
  // Multi-byte UTF-8: 16 emoji = 64 bytes — far over, though 16 "characters".
  assert.throws(() => validateLabel('🦀'.repeat(16)), (err) => {
    assert.equal(err.code, 'LABEL_TOO_LONG');
    assert.match(err.message, /bytes of UTF-8/);
    return true;
  });
  // Exactly 32 bytes of multi-byte UTF-8 is legal: 10 emoji (40 bytes) is not,
  // but é (2 bytes) × 16 = 32 bytes is.
  assert.equal(validateLabel('é'.repeat(16)).length, 32);
  assert.throws(() => validateLabel('é'.repeat(17)), (err) => err.code === 'LABEL_TOO_LONG');
});

test('US-1706 set_label sends the exact UTF-8 bytes and surfaces the touch timeout', async () => {
  const label = 'café';
  const { handlers, vendorCalls } = rig({ sw: SW.OK, data: new Uint8Array(0) });
  await call(handlers, 'set_label', [2, label]);
  assert.deepEqual([...vendorCalls[0].arg], [...new TextEncoder().encode(label)], 'the exact bytes cross');
  assert.equal(vendorCalls[0].idx, 2);

  const { handlers: h2 } = rig({ sw: SW.CONDITIONS_NOT_SATISFIED, data: new Uint8Array(0) });
  const err = await call(h2, 'set_label', [2, label]).then(() => null, (e) => e);
  assert.equal(err.sw, 0x6985);
});

test('US-1706 set_label over 32 bytes is refused at the worker too (belt over the popup brace)', async () => {
  const { handlers, vendorCalls } = rig({ sw: SW.OK, data: new Uint8Array(0) });
  const err = await call(handlers, 'set_label', [0, 'a'.repeat(33)]).then(() => null, (e) => e);
  assert.equal(err.code, 'LABEL_TOO_LONG');
  assert.equal(vendorCalls.length, 0);
});
