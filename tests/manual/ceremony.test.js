// US-1709 — the ceremony page's step wiring: each step issues the right
// command bytes against the mock; the ceremony is ordered (a failed step
// blocks the next, never a partial pass); the INIT step reads capFlags and
// version from the raw reply; the signature verifies against nostr-tools.

import test from 'node:test';
import assert from 'node:assert/strict';

import { schnorr } from '@noble/curves/secp256k1.js';
import { hexToBytes } from '@noble/hashes/utils.js';
import { getEventHash, verifyEvent } from 'nostr-tools';

import { createCeremony, CEREMONY_STEPS } from '../../src/manual/ceremony-steps.js';
import { FapicoSigner, FapicoNip44 } from '../../src/core/seams.js';
import { MockDevice } from '../mock_device.js';

const CID = new Uint8Array([0, 0, 0, 0x2a]);

/** A transport double: GENERATE/DELETE are scripted on top of the mock's
 *  real crypto for the commands the mock serves. */
function ceremonyTransport({ generateSw = 0x9000, deleteSw = 0x9000, pubkeySw = 0x9000 } = {}) {
  const mock = new MockDevice();
  const calls = [];
  return {
    mock,
    calls,
    async open() {
      calls.push({ cmd: 'INIT' });
      return CID;
    },
    async vendor(cmd, idx, arg) {
      calls.push({ cmd, idx, argLen: arg.length });
      if (cmd === 0x46) return { sw: generateSw, data: mock.pub(idx) };
      if (cmd === 0x49) return { sw: deleteSw, data: mock.pub(idx) };
      if (cmd === 0x41 && pubkeySw !== 0x9000) return { sw: pubkeySw, data: new Uint8Array(0) };
      return mock.vendor(cmd, idx, arg);
    },
  };
}

/** The tap the page installs: captures the 17-byte INIT reply payload. */
function initTap() {
  return { reply: null };
}

/** The 17-byte INIT reply payload (nonce echo + CID + verIface + version
 *  0.1.0 + capFlags 0x00), as the ctaphid tests build it. */
function initReplyPayload(nonce, { version = [0x00, 0x01, 0x00], capFlags = 0x00 } = {}) {
  return new Uint8Array([...nonce, ...CID, 0x02, ...version, capFlags]);
}

// The same injected crypto the browser page uses — nostr-tools ground truth.
const crypto = {
  sighashOf: (event, pubkey) => hexToBytes(getEventHash({ ...event, pubkey })),
  verifyEvent: (signed) => verifyEvent(signed),
  schnorrVerify: (sig, msgHash, pub) =>
    schnorr.verify(hexToBytes(sig), msgHash, hexToBytes(pub)),
  nip44RoundTrip: async (nip, peer, plaintext) => {
    const payload = await nip.encrypt(peer, plaintext);
    const round = await nip.decrypt(peer, payload);
    return round.length === plaintext.length && round.every((b, i) => b === plaintext[i])
      ? { ok: true, detail: `round trip ok (${plaintext.length} bytes)` }
      : { ok: false, detail: 'mismatch' };
  },
};

function rig(opts = {}) {
  const transport = ceremonyTransport(opts);
  const tap = initTap();
  transport.open = async (nonce) => {
    transport.calls.push({ cmd: 'INIT' });
    tap.reply = initReplyPayload(nonce, opts.init);
    return CID;
  };
  const ceremony = createCeremony({
    transport,
    initTap: tap,
    signer: new FapicoSigner(transport),
    nip: new FapicoNip44(transport),
    crypto,
  });
  return { ceremony, transport };
}

test('US-1709 the ceremony completes in order: all six steps, right command bytes, verified signature', async () => {
  const { ceremony, transport } = rig();
  const out = await ceremony.runAll();
  assert.equal(out.complete, true, JSON.stringify(out.results));
  assert.deepEqual(ceremony.results.map((r) => r.step), CEREMONY_STEPS);
  assert.ok(ceremony.results.every((r) => r.ok), 'every step passed');
  assert.ok(ceremony.results.every((r) => typeof r.ms === 'number' && r.ms >= 0), 'timing recorded');
  // The wiring: generate and delete ride the requested slot with empty args.
  const gen = transport.calls.find((c) => c.cmd === 0x46);
  const del = transport.calls.find((c) => c.cmd === 0x49);
  assert.equal(gen.idx, 0);
  assert.equal(gen.argLen, 0);
  assert.equal(del.idx, 0);
  // SIGN's argument is exactly a 32-byte sighash; the sign step already ran
  // the signature through nostr-tools' verifyEvent (injected above) and
  // schnorr.verify against the device key.
  const sign = transport.calls.find((c) => c.cmd === 0x42);
  assert.equal(sign.argLen, 32);
  // The nip44 round trip went through the device twice (encrypt, decrypt).
  assert.equal(transport.calls.filter((c) => c.cmd === 0x43).length, 1);
  assert.equal(transport.calls.filter((c) => c.cmd === 0x44).length, 1);
  // INIT happened first.
  assert.equal(transport.calls[0].cmd, 'INIT');
});

test('US-1709 a failed step blocks the next — the ceremony is ordered', async () => {
  // GET_PUBKEY refuses: pubkey fails, sign/nip44/delete are never attempted.
  const { ceremony, transport } = rig({ pubkeySw: 0x6f00 });
  const r1 = await ceremony.runNext(); // init
  assert.equal(r1.step, 'init');
  assert.equal(r1.ok, true);
  const r2 = await ceremony.runNext(); // generate
  assert.equal(r2.step, 'generate');
  const r3 = await ceremony.runNext(); // pubkey — fails
  assert.equal(r3.step, 'pubkey');
  assert.equal(r3.ok, false);
  assert.equal(r3.sw, 0x6f00);
  assert.equal(transport.calls.filter((c) => c.cmd === 0x42).length, 0, 'SIGN never attempted');
  const r4 = await ceremony.runNext();
  assert.deepEqual(r4, { blocked: true, step: null }, 'blocked — nothing further runs');
  assert.equal(ceremony.nextStep, null);
  assert.equal(ceremony.results.length, 3, 'the results name exactly what ran');
});

test('US-1709 an INIT version mismatch blocks at the first step', async () => {
  const transport = ceremonyTransport();
  const tap = initTap();
  transport.open = async (nonce) => {
    transport.calls.push({ cmd: 'INIT' });
    // A hostile wrong version in the captured reply.
    tap.reply = initReplyPayload(nonce, { version: [0x09, 0x00, 0x01] });
    return CID;
  };
  const bad = createCeremony({
    transport,
    initTap: tap,
    signer: new FapicoSigner(transport),
    nip: new FapicoNip44(transport),
    crypto,
  });
  const out = await bad.runNext();
  assert.equal(out.step, 'init');
  assert.equal(out.ok, false);
  assert.match(out.error, /INIT mismatch/);
  assert.equal((await bad.runNext()).blocked, true);
});

test('US-1709 a nonce-mismatched INIT reply is refused, not adopted', async () => {
  const transport = ceremonyTransport();
  const tap = initTap();
  transport.open = async (nonce) => {
    transport.calls.push({ cmd: 'INIT' });
    tap.reply = initReplyPayload(new Uint8Array(8).fill(0x9)); // echoes a different nonce
    return CID;
  };
  const bad = createCeremony({
    transport,
    initTap: tap,
    signer: new FapicoSigner(transport),
    nip: new FapicoNip44(transport),
    crypto,
  });
  const out = await bad.runNext();
  assert.equal(out.ok, false);
  assert.match(out.error, /nonce mismatch/);
});

test('US-1709 the init step reads the capFlags byte the transport discards', async () => {
  const { ceremony } = rig();
  const out = await ceremony.runNext();
  assert.equal(out.step, 'init');
  assert.equal(out.ok, true);
  assert.equal(out.detail.capFlags, 0x00, 'capFlags at byte 16');
  assert.equal(out.detail.version, '0.1.0', 'version at 13..15');
  assert.equal(out.detail.cid, '0000002a');
  assert.equal(ceremony.results[0].capFlags, 0x00, 'the recorded result carries it for the release notes');
});

test('US-1709 a missing INIT tap capture is a typed failure, not a hang', async () => {
  const transport = ceremonyTransport();
  const bad = createCeremony({
    transport,
    initTap: { reply: null }, // the tap saw nothing
    signer: new FapicoSigner(transport),
    nip: new FapicoNip44(transport),
    crypto,
  });
  const out = await bad.runNext();
  assert.equal(out.ok, false);
  assert.match(out.error, /no INIT reply captured/);
});
