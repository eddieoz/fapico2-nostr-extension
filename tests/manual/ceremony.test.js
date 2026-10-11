// US-1709 — the ceremony page's step wiring: each step issues the right
// command bytes against the mock; the ceremony is ordered (a failed step
// blocks the next, never a partial pass); the INIT step reads capFlags and
// version from the raw reply; the signature verifies against nostr-tools.

import test from 'node:test';
import assert from 'node:assert/strict';

import { schnorr } from '@noble/curves/secp256k1.js';
import { hexToBytes } from '@noble/hashes/utils.js';
import { getEventHash, verifyEvent } from 'nostr-tools';

import { createCeremony, rawInit, CEREMONY_STEPS } from '../../src/manual/ceremony-steps.js';
import { FapicoSigner, FapicoNip44 } from '../../src/core/seams.js';
import { MockDevice } from '../mock_device.js';
import { BROADCAST_CID, CMD_INIT, REPORT_SIZE } from '../../src/core/ctaphid.js';

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

function fakeDev(initReplyPayload, { initTimeoutMs } = {}) {
  return {
    oninputreport: null,
    __initTimeoutMs: initTimeoutMs,
    async sendReport({ data }) {
      if (initReplyPayload) {
        this.oninputreport({ data: initReplyPayload, reportId: 0 });
      }
    },
  };
}

function initFrame(nonce) {
  // nonce(8) + cid(4) + verIface(1) + version 0.1.0 (3) + capFlags 0x00 (1)
  // = the 17-byte INIT reply, exactly as the ctaphid tests build it.
  const frame = new Uint8Array(REPORT_SIZE);
  frame.set(BROADCAST_CID, 0);
  frame[4] = CMD_INIT | 0x80;
  frame[5] = 0;
  frame[6] = 17;
  frame.set([...nonce, ...CID, 0x02, 0x00, 0x01, 0x00, 0x00], 7);
  return frame;
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
  const ceremony = createCeremony({
    transport,
    dev: fakeDev(initFrame(new Uint8Array(8).fill(7))),
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

test('US-1709 an INIT mismatch blocks at the first step', async () => {
  const transport = ceremonyTransport();
  // A hostile wrong version in the raw INIT reply.
  const badFrame = initFrame(new Uint8Array(8).fill(7));
  badFrame[7 + 13 + 2] = 0x09; // the version-major byte
  const bad = createCeremony({
    transport,
    dev: fakeDev(badFrame),
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

test('US-1709 rawInit reads the capFlags byte the transport discards', async () => {
  const nonce = new Uint8Array(8).fill(9);
  const dev = fakeDev(initFrame(nonce));
  const { reply } = await rawInit(dev);
  assert.equal(reply.length, 17, 'the 17-byte INIT reply');
  assert.equal(reply[16], 0x00, 'capFlags at byte 16');
  assert.deepEqual([...reply.slice(13, 16)], [0x00, 0x01, 0x00], 'version 0.1.0 at 13..15');
});

test('US-1709 a missing INIT reply is a typed failure, not a hang', async () => {
  const dev = { oninputreport: null, async sendReport() { /* silence */ } };
  await assert.rejects(
    () => rawInit(dev, { timeoutMs: 30 }),
    /no INIT reply/,
  );
});
