// US-1668 — the NostrSigner / Nip44Cipher seams, both implementations of
// each against nostr-tools ground truth. The Software* implementations ARE
// nostr-tools, so their tests pin the contract; the Fapico* implementations
// run over the mock device double (tests/mock_device.js), whose crypto is
// the real thing — so "FapicoSigner signed it" and "nostr-tools verifies it"
// are independently true in every test below.

import test from 'node:test';
import assert from 'node:assert/strict';

import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { base64 } from '@scure/base';
import {
  finalizeEvent,
  generateSecretKey,
  getEventHash,
  getPublicKey,
  nip44,
  verifyEvent,
} from 'nostr-tools';

import {
  FapicoNip44,
  FapicoSigner,
  SoftwareNip44,
  SoftwareSigner,
  SwError,
} from '../src/nostr/seams.js';

import { MockDevice } from './mock_device.js';

const SK0 = hexToBytes('11'.repeat(32));
const SK1 = hexToBytes('22'.repeat(32));

test('US-1668 SoftwareSigner pubkey parity with nostr-tools', async () => {
  const signer = new SoftwareSigner(SK0);
  assert.equal(signer.kind, 'software');
  assert.equal(await signer.getPublicKey(), getPublicKey(SK0));
});

test('US-1668 SoftwareSigner.signEvent verifies with nostr-tools ground truth', async () => {
  const signer = new SoftwareSigner(SK0);
  const event = {
    kind: 1,
    content: 'software seam',
    tags: [['t', 'x']],
    created_at: 1700000000,
  };
  const signed = await signer.signEvent(event);
  assert.equal(signed.pubkey, getPublicKey(SK0));
  assert.equal(signed.id, getEventHash({
    kind: event.kind, tags: event.tags, content: event.content,
    created_at: event.created_at, pubkey: getPublicKey(SK0),
  }));
  assert.ok(verifyEvent(signed), 'nostr-tools verifyEvent must accept it');
});

test('US-1668 signEvent refuses an identity the signer does not hold', async () => {
  const signer = new SoftwareSigner(SK0);
  await assert.rejects(
    () => signer.signEvent({ kind: 1, content: 'x', tags: [], pubkey: getPublicKey(SK1) }),
    (err) => err.code === 'KEY_MISMATCH',
  );
});

test('US-1668 SoftwareNip44 roundtrip matches nostr-tools both directions', async () => {
  const nip = new SoftwareNip44(SK0);
  assert.equal(nip.kind, 'software');
  const peer = getPublicKey(SK1);
  const pt = new TextEncoder().encode('nip44 over the seam');
  const payload = await nip.encrypt(peer, pt);
  // The raw payload format the device speaks: 0x02 ‖ nonce(32) ‖ ct ‖ mac(32).
  assert.equal(payload[0], 0x02);
  // Ground truth decrypt, via the conversation key nostr-tools derives.
  const conv = nip44.getConversationKey(SK1, getPublicKey(SK0));
  const round = new TextEncoder().encode(nip44.v2.decrypt(base64.encode(payload), conv));
  assert.deepEqual(round, pt);
  // And the reverse direction: nostr-tools encrypts (its plaintext is utf8
  // text), the seam decrypts to the original bytes.
  const conv0 = nip44.getConversationKey(SK0, getPublicKey(SK1));
  const theirs = base64.decode(nip44.v2.encrypt(new TextDecoder().decode(pt), conv0));
  assert.deepEqual(await nip.decrypt(getPublicKey(SK1), theirs), pt);
});

test('US-1668 FapicoSigner.getPublicKey is touch-free and carries idx', async () => {
  const mock = new MockDevice();
  const signer = new FapicoSigner(mock);
  assert.equal(signer.kind, 'fapico-hardware');
  const pub = await signer.getPublicKey();
  assert.equal(pub, bytesToHex(mock.pub(0)));
  assert.deepEqual(mock.calls.at(-1), { cmd: 0x41, idx: 0, argLen: 0 });
});

test('US-1668 FapicoSigner with idx 1 addresses the second identity', async () => {
  const mock = new MockDevice();
  const signer = new FapicoSigner(mock, { idx: 1 });
  assert.equal(await signer.getPublicKey(), bytesToHex(mock.pub(1)));
  assert.equal(mock.calls.at(-1).idx, 1);
});

test('US-1668 FapicoSigner.signEvent sends the NIP-01 sighash and verifies as nostr-tools does', async () => {
  const mock = new MockDevice();
  const signer = new FapicoSigner(mock);
  const signed = await signer.signEvent({
    kind: 1,
    content: 'hardware seam',
    tags: [],
    created_at: 1700000042,
  });
  // The SIGN argument was exactly the 32-byte sighash (sha256 of the NIP-01
  // serialization — getEventHash's computation).
  const signCall = mock.calls.at(-1);
  assert.equal(signCall.cmd, 0x42);
  assert.equal(signCall.idx, 0);
  const unsigned = {
    kind: 1, tags: [], content: 'hardware seam',
    created_at: 1700000042, pubkey: bytesToHex(mock.pub(0)),
  };
  assert.equal(bytesToHex(hexToBytes(signed.id)), getEventHash(unsigned));
  // The event verifies as nostr-tools verifies it — the cross-check that
  // the wire plumbing did not mangle a single byte.
  assert.ok(verifyEvent(signed), 'nostr-tools verifyEvent must accept the device signature');
  // And it verifies independently against the device key (BIP-340).
  const ok = schnorr.verify(hexToBytes(signed.sig), hexToBytes(signed.id), mock.pub(0));
  assert.ok(ok, 'schnorr.verify against the device key must hold');
});

test('US-1668 FapicoSigner.signEvent is touch-gated; getPublicKey is not', async () => {
  const mock = new MockDevice({ grants: false });
  const signer = new FapicoSigner(mock);
  // Npubs are public — GET_PUBKEY is deliberately touch-free.
  await signer.getPublicKey();
  await assert.rejects(
    () => signer.signEvent({ kind: 1, content: 'x', tags: [], created_at: 1 }),
    (err) => err instanceof SwError && err.sw === 0x6985,
  );
  assert.equal(mock.lastParked, 0x42, 'the SIGN command is what was refused');
});

test('US-1668 FapicoSigner.listKeys parses the §2.2 enumeration', async () => {
  const mock = new MockDevice();
  const signer = new FapicoSigner(mock);
  const keys = await signer.listKeys();
  assert.deepEqual(keys, [
    { idx: 0, flags: 0, pubkey: bytesToHex(mock.pub(0)), label: 'primary' },
    { idx: 1, flags: 0, pubkey: bytesToHex(mock.pub(1)), label: 'retired' },
  ]);
});

test('US-1668 FapicoNip44.encrypt output decrypts with nostr-tools ground truth', async () => {
  const mock = new MockDevice();
  const nip = new FapicoNip44(mock, { idx: 1 });
  assert.equal(nip.kind, 'fapico-hardware');
  const pt = new TextEncoder().encode('device-side encryption');
  const payload = await nip.encrypt(getPublicKey(SK0), pt);
  assert.equal(payload[0], 0x02);
  // Decrypt with the *software* conversation key of identity 1 ↔ peer SK0.
  const conv = nip44.getConversationKey(SK1, getPublicKey(SK0));
  const round = new TextEncoder().encode(nip44.v2.decrypt(base64.encode(payload), conv));
  assert.deepEqual(round, pt);
});

test('US-1668 FapicoNip44.decrypt consumes nostr-tools-encrypted payloads', async () => {
  const mock = new MockDevice();
  const nip = new FapicoNip44(mock);
  const pt = new TextEncoder().encode('software-side encryption');
  const conv = nip44.getConversationKey(SK0, getPublicKey(SK1));
  const theirs = base64.decode(nip44.v2.encrypt(new TextDecoder().decode(pt), conv));
  const round = await nip.decrypt(getPublicKey(SK1), theirs);
  assert.deepEqual(round, pt);
});

test('US-1668 non-OK status words surface as typed SwErrors carrying the word', async () => {
  const refusal = { vendor: async () => ({ sw: 0x6d00, data: new Uint8Array(0) }) };
  await assert.rejects(
    () => new FapicoSigner(refusal).getPublicKey(),
    (err) => err instanceof SwError && err.sw === 0x6d00,
  );
});

// ---------------------------------------------------------------------------
// US-1683 — a `9000` with the wrong shape is a device fault, not a partial
// answer: every hardware path validates the reply against the method's
// §2.2 response shape BEFORE slicing.
// ---------------------------------------------------------------------------

import { NOSTR_CMD } from '../src/nostr/ctaphid.js';

/** A transport answering a fixed map of cmd -> {sw, data}. */
function scriptedTransport(replies) {
  return {
    vendor: async (cmd) =>
      replies[cmd] ?? { sw: 0x9000, data: new Uint8Array(0) },
  };
}

test('US-1683 GET_PUBKEY: a short 9000 reply is DEVICE_REPLY_MALFORMED, not a 10-byte npub', async () => {
  const signer = new FapicoSigner(
    scriptedTransport({
      [NOSTR_CMD.GET_PUBKEY]: { sw: 0x9000, data: new Uint8Array(10) },
    }),
  );
  await assert.rejects(() => signer.getPublicKey(), (err) => {
    assert.equal(err.code, 'DEVICE_REPLY_MALFORMED');
    assert.equal(err.name, 'SignerError');
    return true;
  });
});

test('US-1683 SIGN: a short 9000 reply is DEVICE_REPLY_MALFORMED, not a 10-byte sig', async () => {
  const pub32 = new Uint8Array(32).fill(0xAB);
  const signer = new FapicoSigner(
    scriptedTransport({
      [NOSTR_CMD.GET_PUBKEY]: { sw: 0x9000, data: pub32 },
      [NOSTR_CMD.SIGN]: { sw: 0x9000, data: new Uint8Array(10) },
    }),
  );
  const event = { kind: 1, content: 'x', created_at: 1700000000, pubkey: bytesToHex(pub32) };
  // Today's code returns {id, sig: '<10-byte hex>'} — the red.
  await assert.rejects(() => signer.signEvent(event), (err) => {
    assert.equal(err.code, 'DEVICE_REPLY_MALFORMED');
    return true;
  });
});

test('US-1683 LIST_KEYS: an entry whose fixed part does not fit is DEVICE_REPLY_MALFORMED', async () => {
  const signer = new FapicoSigner(
    scriptedTransport({
      // n=3 declared, no entry bytes follow.
      [NOSTR_CMD.LIST_KEYS]: { sw: 0x9000, data: new Uint8Array([3, 1]) },
    }),
  );
  await assert.rejects(() => signer.listKeys(), (err) => {
    assert.equal(err.code, 'DEVICE_REPLY_MALFORMED');
    return true;
  });
});

test('US-1683 NIP44_ENCRYPT: below 65 bytes, or a wrong version byte, is DEVICE_REPLY_MALFORMED', async () => {
  const peer = bytesToHex(new Uint8Array(32).fill(0xCD));
  // Shortest malformed reply the shape allows: 64 bytes.
  const short = new FapicoNip44(
    scriptedTransport({
      [NOSTR_CMD.NIP44_ENCRYPT]: { sw: 0x9000, data: new Uint8Array(64) },
    }),
  );
  await assert.rejects(() => short.encrypt(peer, new Uint8Array(4)), (err) => {
    assert.equal(err.code, 'DEVICE_REPLY_MALFORMED');
    return true;
  });
  // And the shape's first byte is the 0x02 version marker: a 65-byte reply
  // without it is malformed too.
  const badVersion = new Uint8Array(65);
  badVersion[0] = 0x01;
  const wrongVersion = new FapicoNip44(
    scriptedTransport({
      [NOSTR_CMD.NIP44_ENCRYPT]: { sw: 0x9000, data: badVersion },
    }),
  );
  await assert.rejects(() => wrongVersion.encrypt(peer, new Uint8Array(4)), (err) => {
    assert.equal(err.code, 'DEVICE_REPLY_MALFORMED');
    return true;
  });
});

test('US-1683 NIP44_DECRYPT: any length is legal (the control row)', async () => {
  const peer = bytesToHex(new Uint8Array(32).fill(0xCD));
  const nip44hw = new FapicoNip44(
    scriptedTransport({
      [NOSTR_CMD.NIP44_DECRYPT]: { sw: 0x9000, data: new Uint8Array(10) },
    }),
  );
  const pt = await nip44hw.decrypt(peer, new Uint8Array(4));
  assert.deepEqual(pt, new Uint8Array(10));
});
