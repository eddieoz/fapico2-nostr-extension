// US-1695 — MV3 lifetime: worker death cannot strand a ceremony. The
// pending-request map is persisted to chrome.storage.session (id, method,
// preview, host, port name, state — no key material), re-adopted on boot,
// the port reconnect re-delivers the outstanding reply or typed error, and
// a pending request whose prompt window no longer exists is rejected
// `ceremony-interrupted`, never a hang.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPendingStore, PENDING_KEY } from '../src/worker/session.js';
import { widenSessionAccess } from '../src/worker/worker_boot.js';

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('US-1695 a pending request re-adopted on boot rejects ceremony-interrupted on the reconnect', async () => {
  const storage = storageStub();
  // Worker A: a request arrives, is persisted pending, the worker "dies"
  // mid-ceremony.
  const workerA = createPendingStore({ storage, windowExists: () => false });
  await workerA.begin({
    id: 'req-1',
    method: 'sign_event',
    preview: 'kind 1 — "hello"',
    host: 'signing.example',
    portName: 'nostr-1',
  });
  assert.equal((await storage.get(PENDING_KEY))[PENDING_KEY].length, 1);

  // Worker B boots over the same storage: adoption settles the stranded
  // ceremony typed — the device's touch window cannot be resumed.
  const workerB = createPendingStore({ storage, windowExists: () => false });
  const interrupted = await workerB.adopt();
  assert.deepEqual(interrupted, ['req-1']);

  // The bridge reconnects the port under the same name: the outstanding
  // typed error is re-delivered, so the page's promise settles — no hang.
  const delivered = await workerB.takeForPort('nostr-1');
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].id, 'req-1');
  assert.equal(delivered[0].error.code, 'CEREMONY_INTERRUPTED');
  assert.equal(delivered[0].error.name, 'CeremonyInterruptedError');
  assert.ok(await workerB.takeForPort('nostr-1').then((r) => r.length === 0), 'delivery is exactly once');
});

test('US-1695 a settled-but-undelivered reply is re-delivered verbatim on the reconnect', async () => {
  const storage = storageStub();
  const workerA = createPendingStore({ storage, windowExists: () => false });
  await workerA.begin({ id: 'req-2', method: 'get_public_key', host: 'a.example', portName: 'nostr-7' });
  // The ceremony completed, but the port died before the reply crossed.
  await workerA.settle('req-2', { result: 'ab'.repeat(32) });

  const workerB = createPendingStore({ storage, windowExists: () => false });
  await workerB.adopt(); // nothing pending — nothing interrupted
  const delivered = await workerB.takeForPort('nostr-7');
  assert.deepEqual(delivered, [{ id: 'req-2', result: 'ab'.repeat(32) }]);
});

test('US-1695 a pending request whose prompt window still exists waits for its decision', async () => {
  const storage = storageStub();
  const workerA = createPendingStore({ storage });
  await workerA.begin({
    id: 'req-3',
    method: 'sign_event',
    host: 'b.example',
    portName: 'nostr-2',
    promptWindowId: 42,
  });
  // The prompt window survived the worker death (it is browser-owned).
  const workerB = createPendingStore({ storage, windowExists: (id) => id === 42 });
  const interrupted = await workerB.adopt();
  assert.deepEqual(interrupted, [], 'the decision can still arrive — nothing to interrupt');
  assert.equal(workerB.get('req-3').state, 'pending');
  // The decision arrives: the request settles normally.
  await workerB.settle('req-3', { result: { sig: 'ff' } });
  assert.deepEqual(await workerB.takeForPort('nostr-2'), [{ id: 'req-3', result: { sig: 'ff' } }]);
});

test('US-1695 the persisted record stores no key material — method, host, preview only', async () => {
  const storage = storageStub();
  const store = createPendingStore({ storage });
  await store.begin({
    id: 'req-4',
    method: 'nip44_decrypt',
    preview: 'peer npub1… — 512-byte payload',
    host: 'chat.example',
    portName: 'nostr-3',
    // A caller that erroneously passes full args is not stored: the record
    // shape is fixed and the store drops unknown fields.
    args: { payload: 'SECRET PLAINTEXT', peer: 'x' },
  });
  const persisted = (await storage.get(PENDING_KEY))[PENDING_KEY][0];
  assert.deepEqual(
    Object.keys(persisted).sort(),
    ['host', 'id', 'method', 'outcome', 'portName', 'preview', 'promptWindowId', 'state'],
    'the record is exactly the re-delivery shape — no args, no plaintext',
  );
});

test('US-1695 a corrupted persisted record fails closed: skipped, never adopted as truth', async () => {
  const storage = storageStub();
  await storage.set({ [PENDING_KEY]: [{}, { id: 'x' }, 'garbage', null] });
  const store = createPendingStore({ storage });
  await store.load();
  assert.equal(store.size, 0, 'no record without a port name is adopted');
  const interrupted = await store.adopt();
  assert.deepEqual(interrupted, []);
});

test('US-1695 boot widens the storage.session access level (the write-block fix)', async () => {
  const attempts = [];
  const fakeChrome = {
    runtime: { id: 'test' },
    storage: {
      session: {
        setAccessLevel: async (opts) => attempts.push(opts.accessLevel),
      },
    },
  };
  await widenSessionAccess(fakeChrome);
  assert.deepEqual(attempts, ['TRUSTED_AND_UNTRUSTED_CONTEXTS']);
  // And a boot without storage.session (a fresh install racing shutdown)
  // does not throw.
  await widenSessionAccess({ runtime: {} });
});
