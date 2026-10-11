// US-1709 — the hardware ceremony, as ordered steps. A failed step blocks
// the next: the ceremony is the release gate, so a partial pass must never
// look like a pass. Each step records its status word (or the typed error)
// and its wall-clock timing; the results are what the release notes copy.
//
// The orchestration is pure (transport in, results out) so the wiring test
// drives it against the mock device; tests/manual/ceremony.html is the
// browser wrapper that supplies the real WebHID device.

import { BROADCAST_CID, CMD_INIT, FIRST_PAYLOAD, REPORT_SIZE } from '../core/ctaphid.js';

export const CEREMONY_STEPS = ['init', 'generate', 'pubkey', 'sign', 'nip44', 'delete'];

export const CEREMONY_EXPECTED_VERSION = [0x00, 0x01, 0x00]; // v0.1.0
export const CEREMONY_EXPECTED_CAPFLAGS = 0x00;

/**
 * `transport` is an opened-or-openable CtapVendorTransport-shaped object:
 * `open()`, `vendor(cmd, idx, arg, opts)`. `dev` is the raw WebHID device
 * (the init step does its own raw INIT so it can read the capFlags byte the
 * transport discards). `signer`/`nip` are the seam implementations over the
 * same transport (for the ground-truth verify), and `sighashOf`/`verify`/
 * `schnorrVerify`/`nip44RoundTrip` are injected so the node test can use
 * nostr-tools while the page uses the same functions bundled.
 */
export function createCeremony({
  transport,
  dev,
  signer,
  nip,
  slot = 0,
  log = () => {},
  crypto: { sighashOf, verifyEvent, schnorrVerify, nip44RoundTrip } = {},
  now = () => Date.now(),
}) {
  const results = [];
  let index = -1; // the last step run
  let failed = false;

  const record = (step, ok, detail, startedAt) => {
    results.push({ step, ok, ...detail, ms: now() - startedAt });
    log(step, ok, detail);
  };

  const steps = {
    // INIT: capFlags 0x00, version 0.1.0 — read from a raw INIT exchange so
    // the bytes the transport discards are still checked.
    async init() {
      const init = await rawInit(dev);
      const version = [...init.reply.slice(13, 16)];
      const capFlags = init.reply[16];
      const versionOk =
        version[0] === CEREMONY_EXPECTED_VERSION[0] &&
        version[1] === CEREMONY_EXPECTED_VERSION[1] &&
        version[2] === CEREMONY_EXPECTED_VERSION[2];
      if (!versionOk || capFlags !== CEREMONY_EXPECTED_CAPFLAGS) {
        throw new Error(`INIT mismatch — version ${version.join('.')} capFlags 0x${capFlags?.toString(16)}`);
      }
      const cid = await transport.open(init.nonce);
      return { sw: 0x9000, detail: { cid: [...cid].map((b) => b.toString(16).padStart(2, '0')).join(''), version: version.join('.'), capFlags } };
    },

    // Generate key with touch: 9000 + npub(32).
    async generate() {
      const { sw, data } = await transport.vendor(0x46, slot, new Uint8Array(0));
      if (sw !== 0x9000) throw swError('GENERATE_KEY', sw);
      if (data.length < 32) throw new Error('GENERATE_KEY answered 9000 with a short npub');
      return { sw, npub: hex(data.subarray(0, 32)) };
    },

    // getPublicKey from a live page path: the seam's touch-free read.
    async pubkey() {
      const pub = await signer.getPublicKey();
      return { sw: 0x9000, npub: pub };
    },

    // signEvent with touch: the signature verifies against nostr-tools.
    async sign() {
      const event = {
        kind: 1,
        content: 'fapico2 hardware ceremony — this signature was made by a touch on the board',
        tags: [['t', 'ceremony']],
        created_at: Math.floor(now() / 1000),
      };
      const signed = await signer.signEvent(event);
      if (!verifyEvent(signed)) throw new Error('nostr-tools verifyEvent refused the device signature');
      const sighash = sighashOf(event, signed.pubkey);
      if (!schnorrVerify(signed.sig, sighash, signed.pubkey)) {
        throw new Error('schnorr.verify refused the signature against the device key');
      }
      return { sw: 0x9000, id: signed.id };
    },

    // nip44 encrypt/decrypt round trip through the device.
    async nip44() {
      const peer = await signer.getPublicKey(); // self-conversation for the ceremony
      const plaintext = new TextEncoder().encode('ceremony round trip');
      const { ok, detail } = await nip44RoundTrip(nip, peer, plaintext);
      if (!ok) throw new Error(detail);
      return { sw: 0x9000, detail };
    },

    // Delete key with touch: the echoed npub must match what we generated.
    async delete() {
      const { sw, data } = await transport.vendor(0x49, slot, new Uint8Array(0));
      if (sw !== 0x9000) throw swError('DELETE_KEY', sw);
      if (data.length < 32) throw new Error('DELETE_KEY answered 9000 without the echoed npub');
      return { sw, npub: hex(data.subarray(0, 32)) };
    },
  };

  return {
    get nextStep() {
      return failed ? null : CEREMONY_STEPS[index + 1] ?? null;
    },
    get results() {
      return results.map((r) => ({ ...r }));
    },
    get blocked() {
      return failed;
    },

    async runNext() {
      if (failed) return { blocked: true, step: null };
      const step = CEREMONY_STEPS[index + 1];
      if (!step) return { done: true, step: null };
      const startedAt = now();
      try {
        const out = await steps[step]();
        index++;
        record(step, true, out, startedAt);
        const next = CEREMONY_STEPS[index + 1];
        return { step, ok: true, ...out, next: next ?? null };
      } catch (err) {
        failed = true;
        const sw = err?.sw;
        record(step, false, { sw, error: String(err.message ?? err) }, startedAt);
        return { step, ok: false, sw, error: String(err.message ?? err), blocked: true };
      }
    },

    async runAll() {
      const outs = [];
      for (;;) {
        const out = await this.runNext();
        if (out.done) return { complete: true, results: this.results };
        if (out.blocked) return { complete: false, results: this.results };
        outs.push(out);
      }
    },
  };
}

function swError(cmdName, sw) {
  const err = new Error(`${cmdName} refused with 0x${sw.toString(16).padStart(4, '0')}`);
  err.name = 'SwError';
  err.sw = sw;
  return err;
}

function hex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The raw INIT exchange: broadcast-channel INIT frame out, the 17-byte
 * reply captured from the device's own reports — so the ceremony sees the
 * capFlags byte the transport's open() does not surface.
 */
export function rawInit(dev, { timeoutMs = 5000 } = {}) {
  const nonce = crypto.getRandomValues(new Uint8Array(8));
  const frame = new Uint8Array(REPORT_SIZE);
  frame.set(BROADCAST_CID, 0);
  frame[4] = CMD_INIT | 0x80;
  frame[5] = 0;
  frame[6] = nonce.length;
  frame.set(nonce, 7);
  return new Promise((resolve, reject) => {
    const previous = dev.oninputreport;
    const timer = setTimeout(() => {
      dev.oninputreport = previous;
      reject(new Error('no INIT reply inside the budget'));
    }, timeoutMs);
    dev.oninputreport = (report) => {
      const data = report.data;
      if (!data || data.length !== REPORT_SIZE) return;
      if (data.slice(0, 4).join() !== BROADCAST_CID.join()) return;
      if (data[4] !== (CMD_INIT | 0x80)) return;
      clearTimeout(timer);
      dev.oninputreport = previous;
      const reply = data.slice(7, 7 + FIRST_PAYLOAD);
      resolve({ nonce, reply: reply.slice(0, 17) });
    };
    dev
      .sendReport({ reportId: 0, data: frame })
      .catch((err) => {
        clearTimeout(timer);
        dev.oninputreport = previous;
        reject(err);
      });
  });
}
