// US-1710 — the active key: one global slot in storage.local, read at
// request time. get/set round-trip; the write path and the read path each
// refuse a non-slot typed BAD_SLOT; page-facing identity ops ride the
// active slot; a page-supplied idx is dropped at the wire; the setting is
// resolved once per request; a second handlers table over the same storage
// (a "worker restart") keeps the slot.

import test from 'node:test';
import assert from 'node:assert/strict';

import { hexToBytes } from '@noble/hashes/utils.js';
import { getPublicKey } from 'nostr-tools';

import { createDeviceOwner } from '../src/worker/device.js';
import { createHandlers } from '../src/worker/handlers.js';
import { createActiveSlotStore, ACTIVE_SLOT_KEY } from '../src/worker/active-slot.js';
import { SW, NOSTR_CMD } from '../src/core/ctaphid.js';
import { MockDevice, bytesToHex } from './mock_device.js';

const NPUB0 = getPublicKey(hexToBytes('11'.repeat(32)));
const NPUB1 = getPublicKey(hexToBytes('22'.repeat(32)));

/** A storage.local double with Map semantics and get(key) -> {key: v}. */
function slotStorage(initial) {
  const data = new Map();
  if (initial !== undefined) data.set(ACTIVE_SLOT_KEY, initial);
  return {
    data,
    async get(k) {
      return data.has(k) ? { [k]: data.get(k) } : {};
    },
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) data.set(k, v);
    },
  };
}

function rig({ storage = slotStorage(), mock = new MockDevice() } = {}) {
  const device = createDeviceOwner({
    getGrantedDevice: async () => ({}),
    createTransport: () => mock,
    openTransport: async () => {},
  });
  const store = createActiveSlotStore({ storage });
  const handlers = createHandlers({
    device,
    getActiveSlot: store.get,
    setActiveSlot: store.set,
  });
  return { handlers, storage, mock, device, store };
}

const call = async (handlers, method, args, sender = { url: 'chrome-extension://x/popup.html' }) =>
  handlers[method](args, { sender, trusted: true, requestId: 't' });

test('US-1710 get_active_slot answers 0 when the key is absent (first run)', async () => {
  const { handlers } = rig();
  assert.deepEqual(await call(handlers, 'get_active_slot', []), { slot: 0 });
});

test('US-1710 set_active_slot persists; get_active_slot reads it back; storage holds the integer', async () => {
  const { handlers, storage } = rig();
  await call(handlers, 'set_active_slot', [3]);
  assert.deepEqual(await call(handlers, 'get_active_slot', []), { slot: 3 });
  assert.equal(storage.data.get(ACTIVE_SLOT_KEY), 3);
});

test('US-1710 set_active_slot refuses a non-slot typed BAD_SLOT and leaves storage untouched', async () => {
  const { handlers, storage } = rig();
  for (const slot of [-1, 8, 1.5, '2', null]) {
    const err = await call(handlers, 'set_active_slot', [slot]).then(() => null, (e) => e);
    assert.equal(err?.code, 'BAD_SLOT', `${JSON.stringify(slot)} refused`);
    assert.equal(err?.name, 'SignerError');
  }
  assert.equal(storage.data.size, 0, 'nothing was written');
});

test('US-1710 an invalid stored value refuses typed BAD_SLOT before any device frame', async () => {
  for (const bad of ['3', 9, 1.5]) {
    const { handlers, mock } = rig({ storage: slotStorage(bad) });
    const err = await call(handlers, 'get_public_key', []).then(() => null, (e) => e);
    assert.equal(err?.code, 'BAD_SLOT');
    assert.equal(mock.calls.length, 0, `no device call for stored ${JSON.stringify(bad)}`);
  }
});

test('US-1710 a read-rejected setting refuses typed BAD_SLOT, never a silent slot 0', async () => {
  const breaking = createHandlers({
    device: { run: async () => ({ sw: 0x9000, data: new Uint8Array(0) }) },
    getActiveSlot: async () => {
      throw new Error('storage exploded');
    },
  });
  const err = await call(breaking, 'get_public_key', []).then(() => null, (e) => e);
  assert.equal(err?.code, 'BAD_SLOT');
  assert.equal(err?.name, 'SignerError');
});

test('US-1710 page-facing identity ops ride the active slot — pubkey and sign', async () => {
  const { handlers, mock } = rig({ storage: slotStorage(1) });
  const pub = await call(handlers, 'get_public_key', []);
  assert.equal(pub, NPUB1, 'get_public_key answered slot 1');
  const signed = await call(handlers, 'sign_event', [{ kind: 1, content: 'gm' }]);
  assert.equal(signed.pubkey, NPUB1, 'signed under slot 1');
  for (const c of mock.calls) {
    assert.equal(c.idx, 1, `command 0x${c.cmd.toString(16)} rode the active slot`);
  }
});

test('US-1710 a page-supplied idx is dropped at the wire — args [5] never reach the device as 5', async () => {
  const { handlers, mock } = rig({ storage: slotStorage(1) });
  await call(handlers, 'get_public_key', [5]);
  assert.equal(mock.calls.length, 1);
  assert.equal(mock.calls[0].idx, 1, 'the device saw the active slot');
});

test('US-1710 the active slot is resolved once per request — a flip lands on the NEXT request', async () => {
  const base = slotStorage(1);
  let reads = 0;
  const counting = {
    async get(k) {
      reads++;
      return base.get(k);
    },
    async set(o) {
      return base.set(o);
    },
  };
  const store = createActiveSlotStore({ storage: counting });
  const { device } = rig();
  const handlers = createHandlers({ device, getActiveSlot: store.get, setActiveSlot: store.set });
  await call(handlers, 'sign_event', [{ kind: 1, content: 'gm' }]);
  assert.equal(reads, 1, 'one setting read per request, not per device op');
  // The flip: the next request rides the new value.
  await base.set({ [ACTIVE_SLOT_KEY]: 0 });
  const pub = await call(handlers, 'get_public_key', []);
  assert.equal(pub, NPUB0);
});

test('US-1710 a "worker restart" (second table over the same storage) keeps the slot', async () => {
  const storage = slotStorage();
  const a = rig({ storage });
  await call(a.handlers, 'set_active_slot', [4]);
  const b = rig({ storage });
  assert.deepEqual(await call(b.handlers, 'get_active_slot', []), { slot: 4 });
});

// US-1710 — the delete-key reset: read AFTER the device delete succeeded;
// reset to 0 only if the setting still names the deleted slot (a re-pick
// during the touch window is not clobbered); best-effort — a storage
// failure never falsifies the delete's outcome; a non-active delete
// leaves the setting alone.

/** A rig whose transport answers DELETE_KEY with the echoed npub (the
 *  MockDevice double does not serve DELETE — deletes ride a scripted
 *  transport, as in keys_destructive.test.js). */
function deleteRig({ storage, npubEcho, beforeReply } = {}) {
  const transport = {
    vendor: async (cmd) => {
      if (cmd === NOSTR_CMD.DELETE_KEY) {
        if (beforeReply) await beforeReply();
        return { sw: SW.OK, data: hexToBytes(npubEcho) };
      }
      return { sw: SW.OK, data: new Uint8Array(0) };
    },
  };
  const device = createDeviceOwner({
    getGrantedDevice: async () => ({}),
    createTransport: () => transport,
    openTransport: async () => {},
  });
  const store = createActiveSlotStore({ storage });
  const handlers = createHandlers({ device, getActiveSlot: store.get, setActiveSlot: store.set });
  return { handlers, storage };
}

test('US-1710 deleting the active slot resets the setting to 0', async () => {
  const { handlers, storage } = deleteRig({ storage: slotStorage(1), npubEcho: NPUB1 });
  await call(handlers, 'delete_key', [1, NPUB1]);
  assert.equal(storage.data.get(ACTIVE_SLOT_KEY), 0);
});

test('US-1710 a re-pick during the touch window is not clobbered (fresh post-delete read)', async () => {
  // The scripted transport parks the delete long enough for the user to
  // re-pick slot 5 mid-request; the post-delete read must see 5 ≠ 1.
  let deleteResolved;
  const gate = new Promise((r) => (deleteResolved = r));
  const storage = slotStorage(1);
  const { handlers } = deleteRig({ storage, npubEcho: NPUB1, beforeReply: () => gate });
  const done = call(handlers, 'delete_key', [1, NPUB1]);
  await storage.set({ [ACTIVE_SLOT_KEY]: 5 }); // the user re-picks during the park
  deleteResolved();
  await done;
  assert.equal(storage.data.get(ACTIVE_SLOT_KEY), 5, 'the re-pick stands');
});

test('US-1710 a failing reset write never falsifies the delete — it still resolves with the echo', async () => {
  const device = createDeviceOwner({
    getGrantedDevice: async () => ({}),
    createTransport: () => ({
      vendor: async (cmd) =>
        cmd === NOSTR_CMD.DELETE_KEY
          ? { sw: SW.OK, data: hexToBytes(NPUB1) }
          : { sw: SW.OK, data: new Uint8Array(0) },
    }),
    openTransport: async () => {},
  });
  const handlers = createHandlers({
    device,
    getActiveSlot: async () => 1,
    setActiveSlot: async () => {
      throw new Error('quota');
    },
  });
  const res = await call(handlers, 'delete_key', [1, NPUB1]);
  assert.equal(res.npub, NPUB1, 'the delete still succeeded');
});

test('US-1710 deleting a non-active slot leaves the setting alone', async () => {
  const third = { idx: 2, scalar: hexToBytes('33'.repeat(32)), label: 'third' };
  const thirdPub = getPublicKey(third.scalar);
  const { handlers, storage } = deleteRig({ storage: slotStorage(1), npubEcho: thirdPub });
  await call(handlers, 'delete_key', [2, thirdPub]);
  assert.equal(storage.data.get(ACTIVE_SLOT_KEY), 1);
});
