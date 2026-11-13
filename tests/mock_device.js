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
import { sha256 } from '@noble/hashes/sha2.js';
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
    // The PIN custody state (US-1705): a durable retry budget of 3, an
    // unlocked flag the mock models per-instance.
    this.pin = null;
    this.retries = 3;
    this.unlocked = false;
    // The custody ceremony (US-1716): the mock starts migration-complete;
    // a test opts a board into the pending state via `ceremonyPending`.
    this.ceremonyPending = false;
    // The touch policy (US-1748): the bypass starts off — every signing
    // arm asks for the press until SET_TOUCH_POLICY idx 1 lands.
    this.touchBypass = false;
    // The bypass ledger (US-1846): the remaining operations in the armed
    // session (0 = not armed) and the ring of bypassed ops, oldest first.
    // An advancing tick keeps the record timestamps strictly ordered.
    this.bypassBudget = 0;
    this.auditRecords = [];
    // US-1849 — the sampled session age while armed (0 = not armed, the
    // firmware's own rule).
    this.bypassAgeMs = 0;
    this._auditTick = Date.now();
    // The GET_INFO body (US-1706): applet_ver ‖ caps ‖ max_plaintext ‖
    // n ‖ flags — a custody-generation board with no PIN by default; the
    // caps carry CAP_TOUCH_POLICY (0x0010, US-1748) and
    // CAP_BYPASS_ACCOUNTING (0x0020, US-1846) too. US-1856 — the mock is
    // a v0.3 board: the v0.3 GET_AUDIT body it serves needs the v0.3
    // advertisement, or the popup's stale-firmware gate (US-1854) would
    // hide the ledger from every device-level test.
    this.info = { appletVer: [0x00, 0x03], caps: 0x003f, maxPlaintext: 0x0700, nIdentities: this.keys.length, flags: 0x00 };
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
      // The PIN custody dialect (US-1691..1694, US-1702) — the mock's
      // model of apps/nostr: verifier-free (a plain compare is enough for
      // a mock), durable counter 63C0|remaining, lockout at the floor.
      case NOSTR_CMD.VERIFY_PIN: {
        const pin = new TextDecoder().decode(arg);
        if (this.pin == null) return { sw: 0x6a82, data: new Uint8Array(0) };
        if (this.retries === 0) return { sw: SW.PIN_LOCKED, data: new Uint8Array(0) };
        if (pin !== this.pin) {
          this.retries -= 1;
          return { sw: 0x63c0 | this.retries, data: new Uint8Array(0) };
        }
        this.retries = 3;
        this.unlocked = true;
        return { sw: SW.OK, data: new Uint8Array(0) };
      }
      case NOSTR_CMD.SET_PIN: {
        const d = new TextDecoder();
        if (idx === 0) {
          if (this.pin != null) return { sw: 0x6a82, data: new Uint8Array(0) };
          this.pin = d.decode(arg);
          this.retries = 3;
          return { sw: SW.OK, data: new Uint8Array(0) };
        }
        // idx 1 = CHANGE: `lc ‖ current ‖ new`.
        const lc = arg[0];
        const cur = d.decode(arg.subarray(1, 1 + lc));
        const nxt = d.decode(arg.subarray(1 + lc));
        if (this.pin == null) return { sw: 0x6a82, data: new Uint8Array(0) };
        if (this.retries === 0) return { sw: SW.PIN_LOCKED, data: new Uint8Array(0) };
        if (cur !== this.pin) {
          this.retries -= 1;
          return { sw: 0x63c0 | this.retries, data: new Uint8Array(0) };
        }
        this.pin = nxt;
        this.retries = 3;
        return { sw: SW.OK, data: new Uint8Array(0) };
      }
      case NOSTR_CMD.LOCK: {
        this.unlocked = false;
        // US-1748 — LOCK clears the touch bypass with the session.
        this.touchBypass = false;
        // US-1846 — and the ledger dies with the armed session (RAM-only).
        this.bypassBudget = 0;
        this.auditRecords = [];
        return { sw: SW.OK, data: new Uint8Array(0) };
      }
      case NOSTR_CMD.SET_TOUCH_POLICY: {
        // US-1748 — the envelope idx rides P1: 0 re-enables the touch
        // (friction-free, every state), 1 disables it for the signing arms
        // behind the applet's refusal ladder — a payload present (6a80),
        // no PIN (6a82), session closed (0x6982), and the consent press
        // denied or never given (0x6985, modelled here by the grants flag).
        if (arg.length > 0) return { sw: SW.WRONG_DATA, data: new Uint8Array(0) };
        if (idx === 0) {
          this.touchBypass = false;
          // US-1846 — the enable leg ends the armed session: budget 0,
          // ring cleared (the session itself stays open).
          this.bypassBudget = 0;
          this.auditRecords = [];
          return { sw: SW.OK, data: new Uint8Array(0) };
        }
        if (this.pin == null) return { sw: 0x6a82, data: new Uint8Array(0) };
        if (!this.unlocked) return { sw: 0x6982, data: new Uint8Array(0) };
        if (!this._grants) return { sw: SW.CONDITIONS_NOT_SATISFIED, data: new Uint8Array(0) };
        this.touchBypass = true;
        // US-1846 — arming loads the budget at full and starts a fresh ring.
        // US-1855 — the budget is 255, the 1-byte field's largest count.
        this.bypassBudget = 255;
        // US-1849 — the sampled session age: the mock anchors it at 0 on
        // arm and a test moves it forward by writing `mock.bypassAgeMs`.
        this.bypassAgeMs = 0;
        this.auditRecords = [];
        return { sw: SW.OK, data: new Uint8Array(0) };
      }
      case NOSTR_CMD.GET_AUDIT: {
        // US-1846 — the ledger read: touch-free, no payload. A PIN-set board
        // with a closed session answers 0x6982 (the gate, not a fault); a
        // PIN-less board answers honestly empty. US-1849 — the v0.3 body:
        // budget(1) ‖ n(1) ‖ age_ms(4 BE) ‖ n × { op(1) ‖ idx(1) ‖
        // ts_ms(4 BE) ‖ digest(16) }, records from offset 6, oldest first.
        // The age reads only while the session is up — a dead session's age
        // is 0, the same rule the firmware pins.
        if (arg.length > 0) return { sw: SW.WRONG_DATA, data: new Uint8Array(0) };
        if (this.pin != null && !this.unlocked) return { sw: 0x6982, data: new Uint8Array(0) };
        const armed = this.bypassBudget > 0;
        const age = armed ? this.bypassAgeMs : 0;
        const body = new Uint8Array(6 + this.auditRecords.length * 22);
        body[0] = this.bypassBudget;
        body[1] = this.auditRecords.length;
        body[2] = (age >>> 24) & 0xff;
        body[3] = (age >>> 16) & 0xff;
        body[4] = (age >>> 8) & 0xff;
        body[5] = age & 0xff;
        this.auditRecords.forEach((r, i) => {
          const off = 6 + i * 22;
          body[off] = r.op;
          body[off + 1] = r.idx;
          body[off + 2] = (r.tsMs >>> 24) & 0xff;
          body[off + 3] = (r.tsMs >>> 16) & 0xff;
          body[off + 4] = (r.tsMs >>> 8) & 0xff;
          body[off + 5] = r.tsMs & 0xff;
          body.set(r.digest, off + 6);
        });
        return { sw: SW.OK, data: body };
      }
      case NOSTR_CMD.IMPORT_KEY: {
        // US-1717's round trip drives the import path: arg = scalar(32),
        // answer = npub(32). An occupied slot is the file-full word.
        if (this.keys.some((k) => k.idx === idx)) {
          return { sw: 0x6a84, data: new Uint8Array(0) };
        }
        if (arg.length !== 32) return { sw: SW.WRONG_DATA, data: new Uint8Array(0) };
        const pub = hexToBytes(getPublicKey(arg));
        this.keys.push({ idx, scalar: arg.slice(), pub, label: 'test copy' });
        return { sw: SW.OK, data: pub.slice() };
      }
      case NOSTR_CMD.DELETE_KEY: {
        const del = this.keys.findIndex((k) => k.idx === idx);
        if (del === -1) return { sw: 0x6a82, data: new Uint8Array(0) };
        const [gone] = this.keys.splice(del, 1);
        return { sw: SW.OK, data: gone.pub.slice() };
      }
      case NOSTR_CMD.CEREMONY_START: {
        // US-1716: the applet's refusal gates, in order — no PIN (6A82),
        // nothing to migrate or already sealed (6F02), else 9000 with
        // migrated(2 BE) ‖ already(2 BE): every identity walked, the PIN
        // record counted separately. Completion clears the pending bit.
        if (this.pin == null) return { sw: 0x6a82, data: new Uint8Array(0) };
        if (!this.ceremonyPending) return { sw: SW.CEREMONY_NOT_NEEDED, data: new Uint8Array(0) };
        this.ceremonyPending = false;
        const body = new Uint8Array(4);
        body[0] = (this.keys.length >> 8) & 0xff;
        body[1] = this.keys.length & 0xff;
        body[3] = 0x01; // the PIN record, migrated already
        return { sw: SW.OK, data: body };
      }
      case NOSTR_CMD.PING: {
        // INS_GET_INFO: applet_ver(2) ‖ caps(2) ‖ max_plaintext(2) ‖
        // n(1) ‖ flags(1); flags mirrors the PIN state (bit0 set, bit1 the
        // unlocked session), bit2 the pending migration (US-1714 — pending
        // implies the PIN is set, so the mock requires both), and bit3 the
        // live touch bypass (US-1748).
        const i = this.info;
        const flags = (i.flags & ~0x03) | (this.pin != null ? 0x01 : 0x00) | (this.unlocked ? 0x02 : 0x00) | (this.pin != null && this.ceremonyPending ? 0x04 : 0x00) | (this.touchBypass ? 0x08 : 0x00);
        const data = new Uint8Array(8);
        data[0] = i.appletVer[0];
        data[1] = i.appletVer[1];
        data[2] = i.caps >> 8;
        data[3] = i.caps & 0xff;
        data[4] = i.maxPlaintext >> 8;
        data[5] = i.maxPlaintext & 0xff;
        data[6] = i.nIdentities;
        data[7] = flags;
        return { sw: SW.OK, data };
      }
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
        this._recordBypass(0x00, idx, arg); // US-1846
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
        this._recordBypass(0x01, idx, arg); // US-1846
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
        this._recordBypass(0x02, idx, arg); // US-1846
        return { sw: SW.OK, data: new TextEncoder().encode(pt) };
      }
      default:
        return { sw: INS_NOT_SUPPORTED, data: new Uint8Array(0) };
    }
  }

  // US-1846 — the ledger entry a bypassed op leaves behind: the budget
  // decrements and the record (op, idx, ms tick, SHA-256 of the request
  // payload truncated to 16 bytes) joins the ring, oldest first.
  _recordBypass(opByte, idx, arg) {
    if (!this.unlocked || !this.touchBypass || this.bypassBudget <= 0) return;
    this.bypassBudget -= 1;
    this._auditTick += 1000;
    this.auditRecords.push({
      op: opByte,
      idx,
      tsMs: this._auditTick & 0xffffffff,
      digest: sha256(arg).subarray(0, 16),
    });
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
