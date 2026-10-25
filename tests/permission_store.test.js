// US-1699 — the permission store: per-host, per-method grants; grant/check/
// revoke round trip; session-only grants die with the worker; a corrupted
// record fails closed; a grant covers exactly the methods approved.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPermissionStore, GRANTS_KEY } from '../src/worker/permissions.js';

function storageStub(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    async get(k) {
      const keys = Array.isArray(k) ? k : [k];
      const out = {};
      for (const key of keys) if (data.has(key)) out[key] = data.get(key);
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

test('US-1699 grant/check/revoke round trip', async () => {
  const store = createPermissionStore({ storage: storageStub() });
  assert.equal(await store.check('signing.example', 'sign_event'), false);
  await store.grant('signing.example', ['sign_event']);
  assert.equal(await store.check('signing.example', 'sign_event'), 'persisted');
  assert.equal(await store.check('signing.example', 'get_public_key'), false,
    'a grant covers exactly the methods approved');
  await store.revoke('signing.example');
  assert.equal(await store.check('signing.example', 'sign_event'), false,
    'revocation deletes the host record');
});

test('US-1699 the persisted shape is exactly host → {grantedAt, methods} with timestamps', async () => {
  const storage = storageStub();
  const store = createPermissionStore({ storage, now: () => 1234 });
  await store.grant('a.example', ['get_public_key', 'sign_event']);
  const rec = storage.data.get(GRANTS_KEY)['a.example'];
  assert.equal(rec.grantedAt, 1234);
  assert.equal(typeof rec.methods.get_public_key, 'number');
  assert.equal(typeof rec.methods.sign_event, 'number');
  assert.deepEqual(Object.keys(rec.methods).sort(), ['get_public_key', 'sign_event']);
});

test('US-1699 a session-only grant dies with the worker — never persisted', async () => {
  const storage = storageStub();
  const workerA = createPermissionStore({ storage });
  workerA.grantSession('b.example', ['sign_event']);
  assert.equal(await workerA.check('b.example', 'sign_event'), 'session');
  assert.equal(storage.data.get(GRANTS_KEY), undefined, 'nothing was written to storage');

  // The worker "restarts": a fresh store over the same storage.
  const workerB = createPermissionStore({ storage });
  assert.equal(await workerB.check('b.example', 'sign_event'), false,
    'the this-time-only grant is gone — the prompt runs again');
});

test('US-1699 a corrupted record fails closed — prompt again, never allow', async () => {
  const storage = storageStub({
    [GRANTS_KEY]: { 'c.example': { grantedAt: 'not-a-number', methods: 'garbage' } },
  });
  const store = createPermissionStore({ storage });
  assert.equal(await store.check('c.example', 'sign_event'), false);
  // And a completely corrupted value:
  const storage2 = storageStub({ [GRANTS_KEY]: 42 });
  const store2 = createPermissionStore({ storage: storage2 });
  assert.equal(await store2.check('d.example', 'get_public_key'), false);
  // A grant attempt over corruption repairs the record, fail-closed style:
  await store2.grant('d.example', ['get_public_key']);
  assert.equal(await store2.check('d.example', 'get_public_key'), 'persisted');
});

test('US-1699 unknown method names never enter the store', async () => {
  const storage = storageStub();
  const store = createPermissionStore({ storage });
  await store.grant('e.example', ['sign_event', 'export_key', 'made_up']);
  const rec = storage.data.get(GRANTS_KEY)['e.example'];
  assert.deepEqual(Object.keys(rec.methods), ['sign_event'],
    'key management is popup-only — it is never a page grant');
});

test('US-1699 concurrent grants do not lose each other — the popup-storm race', async () => {
  // The chat.nostr.com field report: several prompts approved in quick
  // succession (the site fires get_public_key, nip44_encrypt and sign_event
  // concurrently), each with remember — and the popups kept coming. The
  // store's read-modify-write of the whole grants map lost every earlier
  // method's grant to the last write. Both approvals must survive.
  const storage = storageStub();
  let releaseFirstWrite;
  const gate = new Promise((r) => (releaseFirstWrite = r));
  const rawSet = storage.set.bind(storage);
  let firstSet = true;
  storage.set = async (obj) => {
    if (firstSet) {
      firstSet = false;
      await gate; // park the first write; the second grant reads underneath it
    }
    return rawSet(obj);
  };
  const store = createPermissionStore({ storage });
  const a = store.grant('chat.example', ['get_public_key']);
  const b = store.grant('chat.example', ['nip44_encrypt']);
  await new Promise((r) => setTimeout(r, 10)); // b's read happens mid-a's-write
  releaseFirstWrite();
  await Promise.all([a, b]);
  assert.equal(await store.check('chat.example', 'get_public_key'), 'persisted',
    'the first remembered approval is not clobbered by the second');
  assert.equal(await store.check('chat.example', 'nip44_encrypt'), 'persisted',
    'the second remembered approval lands too');
});

test('US-1699 the Sites list and revoke-all', async () => {
  const store = createPermissionStore({ storage: storageStub(), now: () => 7 });
  await store.grant('f.example', ['sign_event']);
  await store.grant('g.example', ['get_public_key', 'list_keys']);
  const sites = await store.list();
  assert.deepEqual(sites.map((s) => s.host).sort(), ['f.example', 'g.example']);
  assert.deepEqual(sites.find((s) => s.host === 'g.example').methods, ['get_public_key', 'list_keys']);
  assert.equal(sites.find((s) => s.host === 'g.example').grantedAt, 7);
  await store.revoke(null);
  assert.deepEqual(await store.list(), []);
  assert.equal(await store.check('f.example', 'sign_event'), false);
});
