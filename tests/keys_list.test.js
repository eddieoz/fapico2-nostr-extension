// US-1703 — list keys: the home screen of the key manager. Fixture bytes
// for 0/1/8 keys render the model (slot index, flags, npub hex + bech32,
// label, occupancy against 8 slots); a truncated reply is a typed error,
// not undefined fields.

import test from 'node:test';
import assert from 'node:assert/strict';

import { hexToBytes } from '@noble/hashes/utils.js';
import { getPublicKey } from 'nostr-tools';

import { FapicoSigner } from '../src/core/seams.js';
import { renderKeysModel, npubBech32 } from '../src/popup/keys.js';
import { NOSTR_CMD, SW } from '../src/core/ctaphid.js';

const LIST = NOSTR_CMD.LIST_KEYS;

/** Build the §2.2 LIST_KEYS reply bytes: n ‖ [idx ‖ flags ‖ npub(32) ‖ len ‖ label]* */
function listKeysReply(entries) {
  const parts = [new Uint8Array([entries.length])];
  for (const e of entries) {
    const label = new TextEncoder().encode(e.label ?? '');
    parts.push(
      new Uint8Array([e.idx, e.flags ?? 0x00]),
      hexToBytes(e.pub),
      new Uint8Array([label.length]),
      label,
    );
  }
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function scripted(replies) {
  return { vendor: async (cmd) => replies[cmd] ?? { sw: SW.OK, data: new Uint8Array(0) } };
}

// A deterministic, valid scalar per slot (scalar 0 is not a valid key).
const KPUB = (i) => getPublicKey(hexToBytes((i + 1).toString(16).padStart(2, '0').repeat(32)));

test('US-1703 zero keys → the empty state, 0/8 occupancy', async () => {
  const signer = new FapicoSigner(scripted({
    [LIST]: { sw: SW.OK, data: new Uint8Array([0]) },
  }));
  const keys = await signer.listKeys();
  const model = renderKeysModel(keys);
  assert.equal(model.rows.length, 0);
  assert.equal(model.occupied, 0);
  assert.deepEqual(model.free, [0, 1, 2, 3, 4, 5, 6, 7], 'all eight slots free');
});

test('US-1703 one key → one row with idx, flags, npub hex + bech32, label', async () => {
  const pub = KPUB(1);
  const signer = new FapicoSigner(scripted({
    [LIST]: { sw: SW.OK, data: listKeysReply([{ idx: 3, flags: 0x01, pub, label: 'main' }]) },
  }));
  const keys = await signer.listKeys();
  assert.equal(keys.length, 1);
  assert.equal(keys[0].idx, 3);
  assert.equal(keys[0].flags, 0x01);
  assert.equal(keys[0].pubkey, pub);
  assert.equal(keys[0].label, 'main');
  const model = renderKeysModel(keys);
  assert.equal(model.rows[0].npubBech32, npubBech32(pub), 'the bech32 form renders');
  assert.ok(model.rows[0].npubBech32.startsWith('npub1'));
  assert.deepEqual(model.free, [0, 1, 2, 4, 5, 6, 7], 'slot 3 is taken');
  assert.equal(model.occupied, 1);
});

test('US-1703 eight keys → full occupancy, no free slots', async () => {
  const entries = Array.from({ length: 8 }, (_, i) => ({
    idx: i,
    flags: 0,
    pub: KPUB(i),
    label: `key ${i}`,
  }));
  const signer = new FapicoSigner(scripted({
    [LIST]: { sw: SW.OK, data: listKeysReply(entries) },
  }));
  const model = renderKeysModel(await signer.listKeys());
  assert.equal(model.occupied, 8);
  assert.deepEqual(model.free, []);
  assert.equal(model.rows[7].label, 'key 7');
});

test('US-1703 a truncated reply is a typed error, not undefined fields', async () => {
  // Declared n=2, one truncated entry.
  const signer = new FapicoSigner(scripted({
    [LIST]: { sw: SW.OK, data: new Uint8Array([2, 1]) },
  }));
  await assert.rejects(() => signer.listKeys(), (err) => err.code === 'DEVICE_REPLY_MALFORMED');
  // A label that overruns the reply:
  const signer2 = new FapicoSigner(scripted({
    [LIST]: {
      sw: SW.OK,
      data: new Uint8Array([1, 0, 0, ...hexToBytes(KPUB(1)), 40, ...new TextEncoder().encode('short')]),
    },
  }));
  await assert.rejects(() => signer2.listKeys(), (err) => err.code === 'DEVICE_REPLY_MALFORMED');
});

test('US-1703 a non-OK reply is the typed SwError with the word', async () => {
  const signer = new FapicoSigner(scripted({
    [LIST]: { sw: SW.STORE_FAULT, data: new Uint8Array(0) },
  }));
  await assert.rejects(() => signer.listKeys(), (err) => err.sw === 0x6f00 && err.name === 'SwError');
});
