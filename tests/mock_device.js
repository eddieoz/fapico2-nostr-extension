// The seam test's device double: the applet side of the vendor dialect,
// in software. It answers the same request envelope the real board answers
// (`CBOR [idx, arg]` in, `map {1: sw, 2: data}` out — the transport handles
// that layer already, so this double sits *behind* it, at the
// `vendor(cmd, idx, arg) -> {sw, data}` contract FapicoSigner consumes).
//
// Its crypto is the real thing — nostr-tools' own BIP-340 signing path and
// NIP-44 v2 — because the point of US-1668/US-1673 is that a signature which
// left this double verifies identically to one nostr-tools produced. What is
// *mocked* is only the board: the keyring in flash, the touch gate (§2.2's
// touch column — and US-1663's park on 0x6985, collapsed here to a
// synchronous refusal word), and the byte layouts of §2.2.

import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { base64 } from '@scure/base';
import { getPublicKey, nip19, nip44 } from 'nostr-tools';

import { NOSTR_CMD, SW } from '../src/core/ctaphid.js';

const TOUCH_GATED = new Set([
  NOSTR_CMD.SIGN,
  NOSTR_CMD.NIP44_ENCRYPT,
  NOSTR_CMD.NIP44_DECRYPT,
  NOSTR_CMD.GENERATE_KEY,
  NOSTR_CMD.IMPORT_KEY,
  NOSTR_CMD.EXPORT_KEY,
  NOSTR_CMD.DELETE_KEY,
  NOSTR_CMD.SET_LABEL,
]);

const INS_NOT_SUPPORTED = 0x6d00;

export class MockDevice {
  constructor({ grants = true } = {}) {
    // Two identities so listKeys has something to enumerate; scalars are
    // fixed so the tests are deterministic.
    this.keys = [
      { idx: 0, scalar: hexToBytes('11'.repeat(32)), label: 'primary' },
      { idx: 1, scalar: hexToBytes('22'.repeat(32)), label: 'retired' },
    ];
    for (const k of this.keys) k.pub = hexToBytes(getPublicKey(k.scalar));
    this._grants = grants;
    this.lastParked = null;
    this.calls = [];
  }

  setGrants(on) {
    this._grants = on;
  }

  pub(i) {
    const k = this.keys.find((k) => k.idx === i);
    if (!k) throw new Error(`mock: no key at ${i}`);
    return k.pub;
  }

  // The `vendor` contract: return `{sw, data}`. FapicoSigner sees exactly
  // what CtapVendorTransport's decodeResponse yields on real hardware.
  async vendor(cmd, idx, arg) {
    this.calls.push({ cmd, idx, argLen: arg.length });

    if (TOUCH_GATED.has(cmd) && !this._grants) {
      // US-1663 collapsed: the parked consent window, as one word. No
      // re-drive here — the seam test only needs the refusal shape.
      this.lastParked = cmd;
      return { sw: SW.CONDITIONS_NOT_SATISFIED, data: new Uint8Array(0) };
    }

    switch (cmd) {
      case NOSTR_CMD.GET_PUBKEY: {
        // §2.2: npub(32) ‖ bech32_npub(63).
        const k = this._key(idx);
        const npub = ascii63(nip19.npubEncode(bytesToHex(k.pub)));
        return { sw: SW.OK, data: concatBytes(k.pub, npub) };
      }
      case NOSTR_CMD.LIST_KEYS: {
        // §2.2: n(1), then per key idx(1) ‖ flags(1) ‖ npub(32) ‖
        // label_len(1) ‖ label.
        const parts = [new Uint8Array([this.keys.length])];
        for (const k of this.keys) {
          const label = new TextEncoder().encode(k.label);
          parts.push(
            new Uint8Array([k.idx, 0x00]),
            k.pub,
            new Uint8Array([label.length]),
            label,
          );
        }
        return { sw: SW.OK, data: concatBytes(...parts) };
      }
      case NOSTR_CMD.SIGN: {
        // arg = sighash(32) → npub(32) ‖ sig(64).
        if (arg.length !== 32) return { sw: SW.WRONG_DATA, data: new Uint8Array(0) };
        const k = this._key(idx);
        const sig = schnorr.sign(arg, k.scalar);
        return { sw: SW.OK, data: concatBytes(k.pub, sig) };
      }
      case NOSTR_CMD.NIP44_ENCRYPT: {
        // arg = peer_x(32) ‖ plaintext(n) → 0x02 ‖ nonce(32) ‖ ct ‖ mac(32)
        // — which is exactly nip44.v2.encrypt's payload.
        if (arg.length < 32) return { sw: SW.WRONG_DATA, data: new Uint8Array(0) };
        const k = this._key(idx);
        // nostr-tools' v2 layer speaks base64-wrapped payloads; the applet
        // (§2.2) speaks the raw bytes. One decode at the device double is
        // all that separates them — the byte format is identical.
        const convKey = nip44.getConversationKey(k.scalar, bytesToHex(arg.subarray(0, 32)));
        const payload = base64.decode(nip44.v2.encrypt(
          new TextDecoder().decode(arg.subarray(32)), convKey));
        return { sw: SW.OK, data: payload };
      }
      case NOSTR_CMD.NIP44_DECRYPT: {
        // arg = sender_x(32) ‖ payload(65+m) → plaintext(n).
        if (arg.length < 32 + 65) return { sw: SW.WRONG_DATA, data: new Uint8Array(0) };
        const k = this._key(idx);
        const convKey = nip44.getConversationKey(k.scalar, bytesToHex(arg.subarray(0, 32)));
        // nostr-tools' v2.decrypt returns a utf8 string; the applet returns
        // the raw plaintext bytes. The seam contract is bytes — encode here
        // so both implementations agree.
        const pt = nip44.v2.decrypt(base64.encode(arg.subarray(32)), convKey);
        return { sw: SW.OK, data: new TextEncoder().encode(pt) };
      }
      default:
        return { sw: INS_NOT_SUPPORTED, data: new Uint8Array(0) };
    }
  }

  _key(idx) {
    const k = this.keys.find((k) => k.idx === idx);
    if (!k) throw Object.assign(new Error('mock: bad index'), { wrongData: true });
    return k;
  }
}

function ascii63(s) {
  // bech32 npub is a 63-char field in §2.2's layout; zero-fill the rest.
  const out = new Uint8Array(63);
  for (let i = 0; i < 63 && i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function concatBytes(...parts) {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export { concatBytes, bytesToHex, hexToBytes };
