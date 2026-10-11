// CTAPHID framing over WebHID for the fapico2 Nostr vendor interface.
//
// The device side of these bytes is `fapico2`'s `firmware/src/ctap_hid.rs`
// (framing) and `firmware/src/nostr_wire.rs` (the vendor vocabulary) — this
// module is the client mirror, and the byte-exact executable spec is
// Chromium's `device/fido/hid/` parser: every frame layout decision here
// (7-byte first-frame header, 57/59 payload split, seq from 0, broadcast-only
// INIT, reply on the request's own command byte) is the shape Chromium sends
// and parses, not an invention.
//
// The Nostr interface is a **vendor** CTAPHID surface: usage page 0xFF00,
// usage 0x01, command bytes 0x40–0x7F carrying the NIP-46-method CBOR
// vocabulary. INIT on the broadcast channel allocates the CID; the reply's
// version bytes name the vendor (0.1.0) with capFlags 0x00 — a generic
// CTAPHID client sees a non-CTAP2 vendor device, deliberately.

export const USAGE_PAGE = 0xff00;
export const USAGE_ID = 0x01;

export const REPORT_SIZE = 64;
export const FIRST_PAYLOAD = REPORT_SIZE - 7; // 57
export const CONT_PAYLOAD = REPORT_SIZE - 5; // 59

// CTAPHID commands (spec §11.2).
export const CMD_INIT = 0x06;
export const CMD_PING = 0x01;
export const CMD_WINK = 0x02;
export const CMD_CANCEL = 0x11;
export const CMD_ERROR = 0x07;
export const CMD_KEEPALIVE = 0x3b;

export const HID_ERR_INVALID_CMD = 0x01;
export const HID_ERR_INVALID_LEN = 0x03;
export const HID_ERR_INVALID_SEQ = 0x04;
export const HID_ERR_TIMEOUT = 0x05;
export const HID_ERR_CHANNEL_BUSY = 0x06;

// The Nostr vendor command set (firmware/src/nostr_wire.rs).
export const NOSTR_CMD = {
  PING: 0x40,
  GET_PUBKEY: 0x41,
  SIGN: 0x42,
  NIP44_ENCRYPT: 0x43,
  NIP44_DECRYPT: 0x44,
  LIST_KEYS: 0x45,
  GENERATE_KEY: 0x46,
  IMPORT_KEY: 0x47,
  EXPORT_KEY: 0x48,
  DELETE_KEY: 0x49,
  SET_LABEL: 0x4a,
};

// The D13 status vocabulary, as it crosses the transport: the vendor CBOR
// response's `sw` field carries the same codes the CCID APDUs answer with.
export const SW = {
  OK: 0x9000,
  WRONG_DATA: 0x6a80,
  CONDITIONS_NOT_SATISFIED: 0x6985, // the touch-required word
  INS_NOT_SUPPORTED: 0x6d00,
  STORE_FAULT: 0x6f00,
};

export const BROADCAST_CID = new Uint8Array([0xff, 0xff, 0xff, 0xff]);

// The default whole-ceremony budget. The device's consent window is 15 s
// (§A.8.3a #4) and its published serve bound is 2750 ms per pass, so a
// touch inside the window plus framing slack fits with room; the caller
// may narrow or widen it.
export const DEFAULT_TIMEOUT_MS = 30_000;

export class CtapError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CtapError";
    this.code = code;
  }
}

export const CtapErr = {
  DEVICE_ABSENT: "DEVICE_ABSENT",
  TIMEOUT: "TIMEOUT",
  BAD_INIT: "BAD_INIT",
  DEVICE_ERROR: "DEVICE_ERROR",
  CANCELLED: "CANCELLED",
};

// --- the vendor request/response CBOR (firmware/src/nostr_wire.rs) ---------

// The request envelope: CBOR array(2) [idx: uint, arg: bytes]. An empty arg
// is the zero-length byte string (0x40); the device treats a bare empty
// payload the same way (the argument-less `ping` form). idx beyond u16 is
// refused here so it cannot half-decode on the device.
export function encodeRequest(idx, arg) {
  if (idx < 0 || idx > 0xffff) throw new RangeError("idx out of u16");
  const a = arg ?? new Uint8Array(0);
  const out = [0x82]; // array(2), always
  if (idx <= 0x17) {
    out.push(idx);
  } else if (idx <= 0xff) {
    out.push(0x18, idx);
  } else {
    out.push(0x19, idx >> 8, idx & 0xff);
  }
  if (a.length <= 23) {
    out.push(0x40 + a.length);
  } else if (a.length <= 0xff) {
    out.push(0x58, a.length);
  } else {
    out.push(0x59, (a.length >> 8) & 0xff, a.length & 0xff);
  }
  out.push(...a);
  return new Uint8Array(out);
}

function readUint(buf, i) {
  const head = buf[i];
  if (head === undefined) return null;
  if (head <= 0x17) return [head, i + 1];
  if (head === 0x18) {
    const v = buf[i + 1];
    return v === undefined ? null : [v, i + 2];
  }
  if (head === 0x19) {
    if (i + 3 > buf.length) return null;
    return [(buf[i + 1] << 8) | buf[i + 2], i + 3];
  }
  return null; // a request/response body never widens beyond u16 heads
}

function readBytes(buf, i) {
  const head = buf[i];
  if (head === undefined) return null;
  let lenStart = i + 1;
  let len;
  if (head >= 0x40 && head <= 0x57) {
    len = head - 0x40;
  } else if (head === 0x58) {
    len = buf[i + 1];
    if (len === undefined) return null;
    lenStart = i + 2;
  } else if (head === 0x59) {
    if (i + 3 > buf.length) return null;
    len = (buf[i + 1] << 8) | buf[i + 2];
    lenStart = i + 3;
  } else {
    return null;
  }
  const end = lenStart + len;
  if (end > buf.length) return null;
  return [buf.slice(lenStart, end), end];
}

// The response decoder: map {1: sw, 2?: data} — one or two entries, u16
// status word, byte-string data. Returns [sw, data] or null on malformed.
export function decodeResponse(buf) {
  if (buf.length === 0) return null;
  const head = buf[0];
  if (head !== 0xa1 && head !== 0xa2) return null;
  const entries = head - 0xa0;
  let i = 1;
  let sw = null;
  let data = new Uint8Array(0);
  for (let n = 0; n < entries; n++) {
    const key = buf[i];
    if (key === undefined) return null;
    if (key === 0x01) {
      const u = readUint(buf, i + 1);
      if (!u) return null;
      sw = u[0];
      i = u[1];
    } else if (key === 0x02) {
      const b = readBytes(buf, i + 1);
      if (!b) return null;
      data = b[0];
      i = b[1];
    } else {
      return null;
    }
  }
  if (sw === null) return null;
  return [sw, data];
}

// --- framing ---------------------------------------------------------------

// One outgoing CTAPHID message as 64-byte reports: the 7-byte first-frame
// header (channel, cmd|0x80, len16), then continuations with a seq byte
// starting at 0. This is the exact split Chromium's writer uses.
export function frameReports(channel, cmd, payload) {
  const reports = [];
  const first = Math.min(payload.length, FIRST_PAYLOAD);
  const init = new Uint8Array(REPORT_SIZE);
  init.set(channel, 0);
  init[4] = cmd | 0x80;
  init[5] = (payload.length >> 8) & 0xff;
  init[6] = payload.length & 0xff;
  init.set(payload.slice(0, first), 7);
  reports.push(init);
  let offset = first;
  let seq = 0;
  while (offset < payload.length) {
    const end = Math.min(offset + CONT_PAYLOAD, payload.length);
    const cont = new Uint8Array(REPORT_SIZE);
    cont.set(channel, 0);
    cont[4] = seq++;
    cont.set(payload.slice(offset, end), 5);
    reports.push(cont);
    offset = end;
  }
  return reports;
}

// --- the transport ---------------------------------------------------------

// A CTAPHID transaction over one open WebHID device. `dev` is anything with
// the WebHID surface used here — `open()`, `close()`, `sendReport(reportId,
// data)` (the real WebHID signature), and an assignable `oninputreport` —
// so the tests drive it with a scripted fake and the page passes a real one.
//
// One transaction at a time (the device serves one per interface, §A.8.3
// #9); every tab must re-INIT (a new CID) rather than reusing another tab's
// channel — the transport therefore allocates its own CID on `open()` and
// never persists it across close.
export class CtapVendorTransport {
  constructor(dev) {
    this.dev = dev;
    this.cid = null;
    this.version = null; // the vendor version bytes [maj, min, patch]
    this._waiters = []; // {channel, resolve, reject, buf, need, timer}
    // The report pump: every incoming report is matched against the
    // waiters here, in the transport, not by the caller's event loop —
    // the caller awaits one promise per ceremony.
    dev.oninputreport = (report) => this._onReport(report);
  }

  // INIT on the broadcast channel: nonce out, nonce echo + CID + vendor
  // version back. The CID comes from the reply, not from us.
  async open(nonce = crypto.getRandomValues(new Uint8Array(8))) {
    await this.dev.open();
    const waiter = this._expect(BROADCAST_CID, CMD_INIT);
    for (const r of frameReports(BROADCAST_CID, CMD_INIT, nonce)) {
      await this.dev.sendReport(0, r); // the real WebHID signature: sendReport(reportId, data)
    }
    const reply = await waiter;
    if (reply.payload.length < 17) throw new CtapError(CtapErr.BAD_INIT, "short INIT reply");
    if (!reply.payload.slice(0, 8).every((b, i) => b === nonce[i])) {
      throw new CtapError(CtapErr.BAD_INIT, "INIT nonce mismatch");
    }
    this.cid = reply.payload.slice(8, 12);
    this.version = reply.payload.slice(13, 16);
    return this.cid;
  }

  // Run one vendor command to completion: request out, keepalives absorbed
  // (0x01 progress, 0x02 up-needed — the touch wait IS the ceremony, §4.1),
  // the reply collected on the command's own byte. `onKeepalive(state)` is
  // called with "processing"/"up-needed" so the UI can show the touch
  // prompt live; `signal.aborted` ends the wait with a CANCEL, and the
  // device's refusal envelope (or whatever it answers a cancel with) is
  // surfaced, not swallowed.
  async vendor(cmd, idx, arg, { timeoutMs = DEFAULT_TIMEOUT_MS, signal, onKeepalive } = {}) {
    if (!this.cid) throw new CtapError(CtapErr.DEVICE_ABSENT, "transport not opened");
    const payload = encodeRequest(idx, arg);
    for (const r of frameReports(this.cid, cmd, payload)) {
      await this.dev.sendReport(0, r); // the real WebHID signature: sendReport(reportId, data)
    }
    const deadline = Date.now() + timeoutMs;
    let sawUpNeeded = false;
    try {
      while (true) {
        const frame = await this._expectFrame(this.cid, Math.max(1, deadline - Date.now()));
        if (frame.cmd === CMD_KEEPALIVE) {
          const state = frame.payload[0] === 0x02 ? "up-needed" : "processing";
          if (state === "up-needed") sawUpNeeded = true;
          if (onKeepalive) onKeepalive(state);
          continue;
        }
        if (frame.cmd === CMD_ERROR) {
          throw new CtapError(CtapErr.DEVICE_ERROR, `device error 0x${frame.payload[0]?.toString(16)}`);
        }
        if (frame.cmd !== cmd) {
          throw new CtapError(CtapErr.DEVICE_ERROR, `reply on unexpected command 0x${frame.cmd.toString(16)}`);
        }
        const [sw, data] = decodeResponse(frame.payload) ?? (() => {
          throw new CtapError(CtapErr.DEVICE_ERROR, "malformed vendor response");
        })();
        return { sw, data, upNeeded: sawUpNeeded };
      }
    } catch (e) {
      if (signal?.aborted) {
        // The CANCEL itself is never acknowledged (spec); the terminal
        // sentence is whatever the device answers the closed window with —
        // for the vendor vocabulary, the 6985 envelope, which a caller that
        // aborted does not want to see as a hard error.
        try {
          const final = await this._cancelAndCollect(cmd);
          if (final) return { ...final, cancelled: true };
        } catch {
          /* the cancel raced the window's own close — either way it is over */
        }
        throw new CtapError(CtapErr.CANCELLED, "ceremony cancelled");
      }
      throw e;
    }
  }

  // Close-path helper: send CANCEL and collect the frame the device ends
  // the window with, if any arrives within the window's own budget. The
  // device's CANCEL is silent when nothing is parked, so absence is normal.
  async _cancelAndCollect(replyCmd, timeoutMs = 20_000) {
    const cancel = frameReports(this.cid, CMD_CANCEL, new Uint8Array(0));
    for (const r of cancel) await this.dev.sendReport(0, r); // the real WebHID signature: sendReport(reportId, data)
    try {
      const frame = await this._expectFrame(this.cid, timeoutMs);
      if (frame.cmd === replyCmd) {
        const [sw, data] = decodeResponse(frame.payload) ?? [null, null];
        if (sw !== null) return { sw, data };
      }
    } catch {
      /* silence is a valid close */
    }
    return null;
  }

  // Await the next frame on `channel` within `timeoutMs`. Frames arrive as
  // reports; a fragmented message is reassembled here (first report carries
  // the length, continuations carry seq from 0).
  _expectFrame(channel, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._waiters = this._waiters.filter((w) => w.timer !== timer);
        reject(new CtapError(CtapErr.TIMEOUT, "no reply inside the budget"));
      }, timeoutMs);
      this._waiters.push({ channel, resolve, reject, timer, buf: null, need: 0 });
    });
  }

  _expect(channel, cmd) {
    return this._expectFrame(channel, DEFAULT_TIMEOUT_MS).then((f) => {
      if (f.cmd !== cmd) throw new CtapError(CtapErr.DEVICE_ERROR, `reply on unexpected command 0x${f.cmd.toString(16)}`);
      return f;
    });
  }

  // The report pump: installed on `dev.oninputreport` at construction.
  // Every waiter filters by channel; a fragmented message accumulates into
  // its waiter until the declared length is complete.
  _onReport(report) {
    const data = report.data;
    if (!data || data.length !== REPORT_SIZE) return;
    const channel = data.slice(0, 4);
    const raw = data[4];
    const waiter = this._waiters.find((w) => w.channel.join() === channel.join());
    if (!waiter) return; // another channel's traffic is not ours to read
    if (raw & 0x80) {
      // First frame of a message (or an unfragmented one).
      const cmd = raw & 0x7f;
      const len = (data[5] << 8) | data[6];
      const payload = new Uint8Array(len);
      const first = Math.min(len, FIRST_PAYLOAD);
      payload.set(data.slice(7, 7 + first));
      if (first === len) {
        this._settle(waiter, cmd, payload);
        return;
      }
      waiter.buf = payload;
      waiter.need = len;
      waiter.have = first;
      waiter.seq = 0;
      waiter.msgCmd = cmd;
      return;
    }
    // Continuation: seq must advance from 0 (the device errors with 0x04
    // otherwise; here an out-of-order report is dropped, and Chromium's
    // parser is the byte-exact spec for what a host may also do).
    const seq = raw;
    if (waiter.buf === null || seq !== waiter.seq) return;
    const chunk = data.slice(5, 5 + Math.min(waiter.need - waiter.have, CONT_PAYLOAD));
    waiter.buf.set(chunk, waiter.have);
    waiter.have += chunk.length;
    waiter.seq++;
    if (waiter.have === waiter.need) {
      // The command byte was folded into the waiter when the message
      // started; keepalive and error frames are never split.
      this._settle(waiter, waiter.msgCmd, waiter.buf);
    }
  }

  _settle(waiter, cmd, payload) {
    this._waiters = this._waiters.filter((w) => w !== waiter);
    clearTimeout(waiter.timer);
    waiter.resolve({ channel: waiter.channel, cmd, payload });
  }

  async close() {
    this.cid = null;
    try {
      await this.dev.close();
    } catch {
      /* a device already gone is closed enough */
    }
  }
}

// WebHID device discovery: the chooser filter names the vendor surface —
// usage page 0xFF00, usage 0x01. The FIDO interface (page 0xF1D0) is a
// different device entry and is NOT what this module opens.
export async function requestDevice(navigator_ = navigator) {
  if (!navigator_.hid) {
    throw new CtapError(CtapErr.DEVICE_ABSENT, "WebHID unavailable in this browser");
  }
  const [dev] = await navigator_.hid.requestDevice({
    filters: [{ usagePage: USAGE_PAGE, usage: USAGE_ID }],
  });
  if (!dev) throw new CtapError(CtapErr.DEVICE_ABSENT, "no device selected");
  return dev;
}
