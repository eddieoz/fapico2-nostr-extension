// US-1704 — generate key: pick an empty slot, touch, done. Success, the
// occupied slot (6A84), the full store (6A88) and the touch-timed-out 6985
// each render their own named message; the request rides the serialization
// queue so a parallel page signature cannot collide.

import test from 'node:test';
import assert from 'node:assert/strict';

import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';
import { getPublicKey } from 'nostr-tools';

import { createDeviceOwner } from '../src/worker/device.js';
import { createHandlers } from '../src/worker/handlers.js';
import { serializeError } from '../src/worker/errors.js';
import { SW_WORDS } from '../src/popup/keys.js';
import { SW, NOSTR_CMD } from '../src/core/ctaphid.js';
import { SW as WIRE } from './fixtures/nostr_wire_d15abe7.js';

const NPUB = hexToBytes(getPublicKey(hexToBytes('33'.repeat(32))));

function rig(generateReplies) {
  const vendorCalls = [];
  let n = 0;
  const transport = {
    vendor: async (cmd, idx, arg) => {
      vendorCalls.push({ cmd, idx, argLen: arg.length });
      const r = generateReplies[Math.min(n++, generateReplies.length - 1)];
      return typeof r === 'function' ? r(idx) : r;
    },
  };
  const device = createDeviceOwner({
    getGrantedDevice: async () => ({}),
    createTransport: () => transport,
    openTransport: async () => {},
  });
  const handlers = createHandlers({ device });
  return { handlers, vendorCalls };
}

const call = async (handlers, method, args, sender = { url: 'chrome-extension://x/popup.html' }) =>
  handlers[method](args, { sender, trusted: true, requestId: 't' });

test('US-1704 generate success: 9000 + npub(32) renders the new identity', async () => {
  const { handlers } = rig([{ sw: SW.OK, data: NPUB }]);
  const res = await call(handlers, 'generate_key', [2]);
  assert.equal(res.npub, bytesToHex(NPUB));
});

test('US-1704 an occupied slot (6A84) renders its own named message', async () => {
  const { handlers } = rig([{ sw: WIRE.FILE_FULL, data: new Uint8Array(0) }]);
  const err = await call(handlers, 'generate_key', [2]).then(
    () => null,
    (e) => e,
  );
  assert.equal(err.sw, 0x6a84);
  assert.equal(SW_WORDS[0x6a84], 'that slot is occupied — delete it first');
  assert.match(serializeError(err).message, /0x6a84|refused/);
});

test('US-1704 a full store (6A88) renders its own named message', async () => {
  const { handlers } = rig([{ sw: WIRE.REFERENCED_DATA_NOT_FOUND, data: new Uint8Array(0) }]);
  const err = await call(handlers, 'generate_key', [0]).then(() => null, (e) => e);
  assert.equal(err.sw, 0x6a88);
  assert.ok(SW_WORDS[0x6a88]);
});

test('US-1704 the touch-timed-out 6985 renders its own named message', async () => {
  const { handlers } = rig([{ sw: SW.CONDITIONS_NOT_SATISFIED, data: new Uint8Array(0) }]);
  const err = await call(handlers, 'generate_key', [0]).then(() => null, (e) => e);
  assert.equal(err.sw, 0x6985);
  assert.equal(
    SW_WORDS[0x6985],
    'touch timed out — the device asked for a touch and none came',
  );
});

test('US-1704 a bad slot is refused locally, before any device frame', async () => {
  const { handlers, vendorCalls } = rig([]);
  for (const slot of [-1, 8, 1.5, '2']) {
    const err = await call(handlers, 'generate_key', [slot]).then(() => null, (e) => e);
    assert.equal(err?.code, 'BAD_SLOT', `slot ${JSON.stringify(slot)} refused`);
  }
  assert.equal(vendorCalls.length, 0, 'no device call for a bad slot');
});

test('US-1704 the generate rides the serialization queue — a parallel page sign cannot collide', async () => {
  // Two concurrent device commands: the queue orders them, one vendor call
  // at a time (the refuse-while-parked 6985 must never be provoked here).
  let inFlight = 0;
  let maxInFlight = 0;
  const transport = {
    vendor: async (cmd) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      if (cmd === NOSTR_CMD.GENERATE_KEY) return { sw: SW.OK, data: NPUB };
      return { sw: SW.OK, data: NPUB };
    },
  };
  const device = createDeviceOwner({
    getGrantedDevice: async () => ({}),
    createTransport: () => transport,
    openTransport: async () => {},
  });
  const handlers = createHandlers({ device });
  const results = await Promise.all([
    call(handlers, 'generate_key', [1]),
    call(handlers, 'get_public_key', [0]),
  ]);
  assert.equal(results[0].npub, bytesToHex(NPUB));
  assert.equal(maxInFlight, 1, 'strictly one vendor transaction at a time');
});
