// US-1668 — the project's first pluggable crypto seam (design §4): a
// `NostrSigner` interface and a `Nip44Cipher` seam over the same transport,
// each with two implementations. This is a **parallel code path, not a
// retrofit** — NIP-44 and OpenPGP share no key model, no armour format and
// no fingerprint binding, so nothing here reaches into the PGP side.
//
// The two implementations:
//   - `SoftwareSigner` / `SoftwareNip44` — nostr-tools, in-memory nsec, for
//     the test suite (ground truth) and for a user who has *chosen*
//     software-only. Never a fallback (design D10 — US-1671 owns the
//     loudness of that).
//   - `FapicoSigner` / `FapicoNip44` — over a transport (the WebHID
//     `CtapVendorTransport`, or anything with the same
//     `vendor(cmd, idx, arg) -> {sw, data}` shape). The key never leaves the
//     board; every signing or ciphering call is touch-gated by the device
//     (§2.2's touch column), except `GET_PUBKEY`/`LIST_KEYS`, which are
//     deliberately touch-free — npubs are public.
//
// The seam contract the two implementations share (so a hardware signature
// and a software one verify identically, US-1673):
//   NostrSigner:  kind | 'software' | 'fapico-hardware'
//                 getPublicKey() -> hex x-only pubkey
//                 signEvent(event) -> {id, sig, pubkey, kind, tags, content, created_at}
//                 listKeys() -> [{idx, flags, pubkey, label}]
//   Nip44Cipher:  kind
//                 encrypt(peerHex, plaintextBytes) -> raw payload bytes
//                     (0x02 ‖ nonce(32) ‖ ciphertext ‖ mac(32) — the format
//                      §2.2's NIP44_ENCRYPT answers with)
//                 decrypt(peerHex, payloadBytes) -> plaintextBytes
//
// Non-OK status words surface as a typed `SwError` carrying the word —
// 0x6985 (the touch-required word) above all, which callers use to decide
// "show the touch prompt", never to silently re-drive or fall back.
//
// US-1683 — a `9000` with the wrong shape is a device fault, not a partial
// answer: every hardware path validates the reply's length against the
// method's §2.2 response shape BEFORE slicing, and a violation is one typed
// error (`SignerError('DEVICE_REPLY_MALFORMED', …)`) across all five paths.
// The alternative — a truncated-but-`9000` reply (a firmware bug, a hostile
// downgrade, or a transport fault landing as a short buffer) — would yield a
// short sig, empty pubkeys or `idx: undefined` instead of a failure. The one
// exception is NIP44_DECRYPT, whose answer has no fixed minimum.

import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';
import { base64 } from '@scure/base';
import { finalizeEvent, getEventHash, getPublicKey, nip44 } from 'nostr-tools';

import { NOSTR_CMD, SW } from './ctaphid.js';

/** A device status word the seam's caller must render (§2.2.0). */
export class SwError extends Error {
  constructor(cmdName, sw) {
    super(`${cmdName} refused with 0x${sw.toString(16).padStart(4, '0')}`);
    this.name = 'SwError';
    this.sw = sw;
    this.code = 'SW_' + sw.toString(16);
  }
}

/** A request the signer refuses before anything reaches the device. */
export class SignerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SignerError';
    this.code = code;
  }
}

function requireOk(cmdName, sw) {
  if (sw !== SW.OK) throw new SwError(cmdName, sw);
}

/** US-1683: the reply must carry at least `minLen` bytes before slicing. */
function requireShape(cmdName, data, minLen, what) {
  if (data.length < minLen) {
    throw new SignerError(
      'DEVICE_REPLY_MALFORMED',
      `${cmdName} answered 9000 with ${data.length} byte(s) — ${what} needs at least ${minLen}`,
    );
  }
}

// The software implementations — nostr-tools with the nsec in process.

export class SoftwareSigner {
  /** @param {Uint8Array} secretKey 32-byte nsec scalar */
  constructor(secretKey) {
    this.sk = secretKey;
    this.pub = getPublicKey(secretKey);
  }

  get kind() {
    return 'software';
  }

  async getPublicKey() {
    return this.pub;
  }

  async signEvent(event) {
    if (event.pubkey != null && event.pubkey !== this.pub) {
      throw new SignerError(
        'KEY_MISMATCH',
        `event names pubkey ${event.pubkey} but the software signer holds ${this.pub}`,
      );
    }
    return finalizeEvent(
      {
        kind: event.kind,
        tags: event.tags ?? [],
        content: event.content ?? '',
        created_at: event.created_at ?? Math.floor(Date.now() / 1000),
        pubkey: this.pub,
      },
      this.sk,
    );
  }

  async listKeys() {
    return [{ idx: 0, flags: 0, pubkey: this.pub, label: 'software' }];
  }
}

export class SoftwareNip44 {
  /** @param {Uint8Array} secretKey 32-byte nsec scalar */
  constructor(secretKey) {
    this.sk = secretKey;
  }

  get kind() {
    return 'software';
  }

  async encrypt(peerHex, plaintext) {
    const conv = nip44.getConversationKey(this.sk, peerHex);
    // NIP-44's plaintext is utf8 text (nostr-tools v2.encrypt takes a
    // string), so the bytes cross as utf8; and its v2 layer speaks
    // base64-wrapped payloads where the seam (and the device) speak the raw
    // bytes underneath — one decode each way.
    return base64.decode(nip44.v2.encrypt(new TextDecoder().decode(plaintext), conv));
  }

  async decrypt(peerHex, payload) {
    const conv = nip44.getConversationKey(this.sk, peerHex);
    // v2.decrypt returns a utf8 string; the seam contract is bytes, so the
    // two implementations agree.
    return new TextEncoder().encode(nip44.v2.decrypt(base64.encode(payload), conv));
  }
}

// The hardware implementations — the board holds the keys, the touch is the
// consent.

export class FapicoSigner {
  /**
   * @param {object} transport anything with
   *   `vendor(cmd, idx, arg) -> Promise<{sw, data}>` — the WebHID
   *   CtapVendorTransport on a real device, the mock double in tests.
   * @param {{idx?: number}} opts which identity slot to sign with.
   */
  constructor(transport, { idx = 0 } = {}) {
    this.transport = transport;
    this.idx = idx;
  }

  get kind() {
    return 'fapico-hardware';
  }

  /** Touch-free by design (§2.2): npubs are public. */
  async getPublicKey() {
    const { sw, data } = await this.transport.vendor(
      NOSTR_CMD.GET_PUBKEY, this.idx, new Uint8Array(0));
    requireOk('GET_PUBKEY', sw);
    // §2.2: npub(32) ‖ bech32_npub(63) — the seam returns the hex x-only key.
    requireShape('GET_PUBKEY', data, 32, 'npub(32)');
    return bytesToHex(data.subarray(0, 32));
  }

  /**
   * The device signs the NIP-01 sighash (sha256 of the serialization) and
   * nothing else — the sighash is what binds the signature to the event.
   */
  async signEvent(event) {
    const pubkey = await this.getPublicKey();
    if (event.pubkey != null && event.pubkey !== pubkey) {
      throw new SignerError(
        'KEY_MISMATCH',
        `this site still expects a different key — the active key was changed in the fapico2 popup; switch back there or re-connect the site (site expects ${event.pubkey.slice(0, 16)}…, active identity ${pubkey.slice(0, 16)}…)`,
      );
    }
    const e = {
      kind: event.kind,
      tags: event.tags ?? [],
      content: event.content ?? '',
      created_at: event.created_at ?? Math.floor(Date.now() / 1000),
      pubkey,
    };
    const sighash = getEventHash(e);
    const { sw, data } = await this.transport.vendor(
      NOSTR_CMD.SIGN, this.idx, hexToBytes(sighash));
    requireOk('SIGN', sw);
    // §2.2: npub(32) ‖ sig(64). Validated before slicing (US-1683), then the
    // board names what it signed under — take the device's word for the
    // identity, but never silently.
    requireShape('SIGN', data, 96, 'npub(32) ‖ sig(64)');
    const signedPub = bytesToHex(data.subarray(0, 32));
    if (signedPub !== pubkey) {
      throw new SignerError(
        'KEY_MISMATCH',
        `device signed under ${signedPub}, requested ${pubkey}`,
      );
    }
    return { ...e, id: sighash, sig: bytesToHex(data.subarray(32, 96)) };
  }

  /** Touch-free by design (§2.2): the enumeration names no secrets. */
  async listKeys() {
    const { sw, data } = await this.transport.vendor(
      NOSTR_CMD.LIST_KEYS, 0, new Uint8Array(0));
    requireOk('LIST_KEYS', sw);
    if (data.length < 1) {
      throw new SignerError(
        'DEVICE_REPLY_MALFORMED',
        'LIST_KEYS answered 9000 with no count byte',
      );
    }
    const n = data[0];
    let o = 1;
    const keys = [];
    for (let i = 0; i < n; i++) {
      // US-1683: each entry's 35-byte fixed part (idx, flags, pubkey(32),
      // labelLen) plus its label must fit the reply — validate before slicing.
      if (o + 35 > data.length) {
        throw new SignerError(
          'DEVICE_REPLY_MALFORMED',
          `LIST_KEYS entry ${i} truncated: the 35-byte fixed part does not fit ${data.length - o} byte(s)`,
        );
      }
      const idx = data[o];
      const flags = data[o + 1];
      const pubkey = bytesToHex(data.subarray(o + 2, o + 34));
      const labelLen = data[o + 34];
      if (o + 35 + labelLen > data.length) {
        throw new SignerError(
          'DEVICE_REPLY_MALFORMED',
          `LIST_KEYS entry ${i} truncated: its ${labelLen}-byte label does not fit`,
        );
      }
      const label = new TextDecoder().decode(
        data.subarray(o + 35, o + 35 + labelLen));
      o += 35 + labelLen;
      keys.push({ idx, flags, pubkey, label });
    }
    return keys;
  }
}

export class FapicoNip44 {
  /**
   * @param {object} transport same contract as FapicoSigner's.
   * @param {{idx?: number}} opts which identity slot to encrypt/decrypt with.
   */
  constructor(transport, { idx = 0 } = {}) {
    this.transport = transport;
    this.idx = idx;
  }

  get kind() {
    return 'fapico-hardware';
  }

  async encrypt(peerHex, plaintext) {
    const arg = new Uint8Array(32 + plaintext.length);
    arg.set(hexToBytes(peerHex));
    arg.set(plaintext, 32);
    const { sw, data } = await this.transport.vendor(
      NOSTR_CMD.NIP44_ENCRYPT, this.idx, arg);
    requireOk('NIP44_ENCRYPT', sw);
    // Already the raw payload: 0x02 ‖ nonce(32) ‖ ct ‖ mac(32) — the same
    // format SoftwareNip44 produces. Shape-validated before returning
    // (US-1683): 65 bytes minimum, and the 0x02 version marker first.
    requireShape('NIP44_ENCRYPT', data, 65, '0x02 ‖ nonce(32) ‖ ct ‖ mac(32)');
    if (data[0] !== 0x02) {
      throw new SignerError(
        'DEVICE_REPLY_MALFORMED',
        `NIP44_ENCRYPT answered 9000 with version byte 0x${data[0].toString(16)} — 0x02 required`,
      );
    }
    return data;
  }

  async decrypt(peerHex, payload) {
    const arg = new Uint8Array(32 + payload.length);
    arg.set(hexToBytes(peerHex));
    arg.set(payload, 32);
    const { sw, data } = await this.transport.vendor(
      NOSTR_CMD.NIP44_DECRYPT, this.idx, arg);
    requireOk('NIP44_DECRYPT', sw);
    return data;
  }
}
