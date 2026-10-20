// US-1751 — a restarted worker re-delivers the outstanding consent decision to
// the reconnecting bridge port. Two fixes, one test:
//
//  (a) the consent gate keys the record by the port name the bridge actually
//      reopens (`nostr-<random>`, seen as `port.name` and threaded from the
//      handler's ctx.port through pageMethod into the gate) — not the constant
//      'nostr-consent' that no connecting port ever uses;
//  (b) takeForPort echoes the BARE frame id, not the dispatch composite
//      (portName/frameId) — the provider's pending map matches by the bare id
//      (the worker.js NOTE's warning, R-6).
//
// Fail-closed is preserved: a record whose port never reconnects is delivered
// to no other port, and a still-pending record is adopted, never granted.

import test from 'node:test';
import assert from 'node:assert/strict';

import { hexToBytes } from '@noble/hashes/utils.js';
import { getPublicKey } from 'nostr-tools';

import { createPendingStore, PENDING_KEY } from '../src/worker/session.js';
import { createConsentGate } from '../src/worker/consent.js';
import { createHandlers } from '../src/worker/handlers.js';
import { createDispatch } from '../src/worker/dispatch.js';
import { createDeviceOwner } from '../src/worker/device.js';
import { SW } from '../src/core/ctaphid.js';

const NPUB = hexToBytes(getPublicKey(hexToBytes('33'.repeat(32))));
const PORT_NAME = 'nostr-abc'; // what a real bridge reopens after a restart

/** A storage.session double whose contents survive a "worker death". */
function storageStub() {
  const data = new Map();
  return {
    data,
    async get(keys) {
      const out = {};
      for (const k of Array.isArray(keys) ? keys : [keys]) {
        if (data.has(k)) out[k] = data.get(k);
      }
      return out;
    },
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) data.set(k, v);
    },
    async remove(k) {
      data.delete(k);
    },
  };
}

function rig() {
  const storage = storageStub();
  const transport = {
    vendor: async (cmd) => ({ sw: SW.OK, data: NPUB }),
  };
  const device = createDeviceOwner({
    getGrantedDevice: async () => ({}),
    createTransport: () => transport,
    openTransport: async () => {},
  });
  const pending = createPendingStore({ storage, windowExists: () => false });
  const consent = createConsentGate({
    permissions: {
      check: async () => null,
      grant: async () => {},
      grantSession: () => {},
      list: async () => [],
      revoke: async () => {},
    },
    prompt: {
      ask: async () => ({ remember: false }),
      settle: async () => {},
    },
    pending,
  });
  const handlers = createHandlers({ device, consent });
  // extensionId is passed explicitly (no chrome global in the test runner).
  const route = createDispatch(handlers, { extensionId: 'test' });
  const port = { name: PORT_NAME };
  // A tab sender: untrusted, so the consent gate runs before the device.
  const sender = { url: 'https://page.example/chat' };
  return { storage, route, port, sender };
}

test('US-1751 a restarted worker re-delivers the decision to the reconnecting port, under the bare frame id', async () => {
  const { storage, route, port, sender } = rig();

  // The tab request: the bridge relays frame id p0 over the port nostr-abc.
  // The consent gate runs (untrusted sender), records the pending decision,
  // the prompt approves, and the device op completes — the dispatch replies
  // with the bare id, but the record is keyed by the composite until re-delivery.
  const reply = await route({ id: 'p0', method: 'get_public_key', args: [] }, sender, port);
  assert.equal(reply.id, 'p0', 'the live reply echoes the bare frame id');
  assert.ok(reply.result, 'the device op completed');

  // The worker dies. Worker B boots over the same storage.
  const workerB = createPendingStore({ storage, windowExists: () => false });
  const interrupted = await workerB.adopt();
  assert.deepEqual(interrupted, [], 'the decision already arrived — nothing to interrupt');

  // The bridge reconnects the port under the SAME name: the outstanding
  // decision is re-delivered, keyed by the port the bridge actually reopens.
  const delivered = await workerB.takeForPort(PORT_NAME);
  assert.equal(delivered.length, 1, 'the record was keyed by the real port name, not nostr-consent');
  assert.equal(
    delivered[0].id,
    'p0',
    'the re-delivered reply echoes the BARE frame id — the provider pending map matches it',
  );
  assert.notEqual(delivered[0].id, `${PORT_NAME}/p0`, 'not the dispatch composite');
});

test('US-1751 fail closed: a record whose port never reconnects is delivered to no other port', async () => {
  const { storage, route, port, sender } = rig();
  await route({ id: 'p1', method: 'get_public_key', args: [] }, sender, port);

  // The worker dies and the port never comes back (tab closed). Worker B:
  // nothing is delivered to a differently-named port, and nothing is granted.
  const workerB = createPendingStore({ storage, windowExists: () => false });
  await workerB.adopt();
  assert.deepEqual(await workerB.takeForPort('nostr-other'), [], 'no cross-port delivery');
  assert.equal(workerB.size, 1, 'the record is kept, not silently dropped');
});
