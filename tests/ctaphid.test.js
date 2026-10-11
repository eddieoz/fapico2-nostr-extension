// The CTAPHID-over-WebHID transport, against Chromium's byte-exact framing.
//
// The fake device is scripted: the test queues the exact 64-byte reports the
// fapico2 firmware answers with (the firmware's own hid_serve tests build the
// same bytes) and the transport must survive them — including a ~1.9 KB
// NIP-44 command fragmented over ~30 reports, keepalives interleaved, and a
// reply arriving on the request's own command byte.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  encodeRequest,
  decodeResponse,
  frameReports,
  CtapVendorTransport,
  requestDevice,
  CtapError,
  CtapErr,
  NOSTR_CMD,
  SW,
  FIRST_PAYLOAD,
  CONT_PAYLOAD,
  REPORT_SIZE,
  BROADCAST_CID,
  CMD_INIT,
  CMD_KEEPALIVE,
  USAGE_PAGE,
  USAGE_ID,
} from "../src/core/ctaphid.js";

// A scripted WebHID device: `respond(reports)` plays the device's answers
// into whatever handler the transport installed, in order.
class FakeDevice {
  constructor() {
    this.sent = [];
    this.oninputreport = null;
    this.opened = false;
    this.closed = false;
    this.script = [];
  }

  async open() {
    this.opened = true;
  }

  async close() {
    this.closed = true;
  }

  async sendReport({ data }) {
    this.sent.push(new Uint8Array(data));
    // The device answers after the report is on the wire — deferred so the
    // transport has registered its waiter before a scripted reply lands
    // (a synchronous call would race the transport's own setup).
    const producers = this.script.splice(0);
    // One timer per scripted producer: the transport re-registers its
    // waiter between frames (each keepalive closes one wait), so the
    // device's answers must not land in one synchronous burst or the
    // transport would miss them — real hardware never bursts either.
    producers.forEach((produce, i) => {
      setTimeout(() => {
        for (const r of produce(this.sent)) {
          this.oninputreport({ data: r, reportId: 0 });
        }
      }, i * 5);
    });
  }

  respond(...producers) {
    this.script.push(...producers);
  }
}

const chan = (b0, b1, b2, b3) => new Uint8Array([b0, b1, b2, b3]);

// Build the device's answer frame as the firmware would: one or more
// reports, header (channel, cmd|0x80, len16), payload split 57/59.
function replyReports(channel, cmd, payload) {
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

const CID = chan(0x00, 0x00, 0x00, 0x2a);
const NONCE = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

function initReplyPayload(nonce = NONCE) {
  // nonce(8) + cid(4) + verIface(2) + vendor version (0.1.0) + capFlags(0)
  return new Uint8Array([...nonce, ...CID, 0x02, 0x00, 0x01, 0x00, 0x00]);
}

async function openedTransport(scriptInit = true) {
  const dev = new FakeDevice();
  const t = new CtapVendorTransport(dev);
  if (scriptInit) {
    dev.respond(() => replyReports(BROADCAST_CID, CMD_INIT, initReplyPayload()));
  }
  await t.open(NONCE);
  return { dev, t };
}

test("the INIT handshake allocates the CID from the reply, with the vendor version read back", async () => {
  const { dev, t } = await openedTransport();
  assert.deepEqual(t.cid, CID);
  assert.deepEqual(t.version, new Uint8Array([0x00, 0x01, 0x00]));
  // The request frame, byte-exact: broadcast, INIT|0x80, len 8, the nonce.
  assert.equal(dev.sent.length, 1);
  const sent = dev.sent[0];
  assert.deepEqual(sent.slice(0, 4), BROADCAST_CID);
  assert.equal(sent[4], CMD_INIT | 0x80);
  assert.deepEqual(sent.slice(5, 7), new Uint8Array([0, 8]));
  assert.deepEqual(sent.slice(7, 15), NONCE);
});

test("an INIT reply whose nonce does not echo is refused, not adopted", async () => {
  const dev = new FakeDevice();
  const t = new CtapVendorTransport(dev);
  dev.respond(() => replyReports(BROADCAST_CID, CMD_INIT, initReplyPayload(new Uint8Array(8).fill(0x9))));
  await assert.rejects(() => t.open(NONCE), CtapError);
});

test("a vendor request is framed 57/59 with continuation seq from 0 — the Chromium split", async () => {
  const { dev, t } = await openedTransport();
  // A 100-byte argument: first report carries 57 bytes, one continuation 43.
  const arg = new Uint8Array(100).map((_, i) => i & 0xff);
  dev.respond(() => {
    const [sw, data] = [SW.OK, new Uint8Array(4).fill(0xab)];
    return replyReports(CID, NOSTR_CMD.GET_PUBKEY, new Uint8Array([0xa1, 0x01, 0x19, 0x90, 0x00, 0x02, 0x58, 0x04, ...data]));
  });
  const res = await t.vendor(NOSTR_CMD.GET_PUBKEY, 0, arg);
  assert.equal(res.sw, SW.OK);
  const req = dev.sent[1];
  assert.equal(req[4], NOSTR_CMD.GET_PUBKEY | 0x80);
  // 0x82 + idx(1) + 0x58 + len(1) + 100 bytes = 104.
  assert.deepEqual(req.slice(5, 7), new Uint8Array([0, 104]));
  const cont = dev.sent[2];
  assert.equal(cont[4], 0, "first continuation seq is 0");
  // Payload continuity: the 57/59 split must reassemble byte-exactly.
  const whole = new Uint8Array(104);
  whole.set(req.slice(7, 7 + FIRST_PAYLOAD));
  whole.set(cont.slice(5, 5 + 43), FIRST_PAYLOAD);
  assert.deepEqual(whole.slice(0, 3), new Uint8Array([0x82, 0x00, 0x58]));
});

test("a ~1.9 KB NIP-44 command fragments over many reports and reassembles on the wire", () => {
  // The framing math the device's NOSTR_RESP_MAX derivation rests on:
  // a 1929-byte payload = 57 + 31×59 + r.
  const payload = new Uint8Array(1929);
  const reports = frameReports(CID, NOSTR_CMD.NIP44_ENCRYPT, payload);
  assert.equal(reports.length, 1 + Math.ceil((1929 - FIRST_PAYLOAD) / CONT_PAYLOAD));
  let offset = FIRST_PAYLOAD;
  for (const [i, r] of reports.slice(1).entries()) {
    assert.equal(r[4], i, "continuation seq advances from 0");
    assert.deepEqual(r.slice(0, 4), CID);
  }
  assert.ok(reports.every((r) => r.length === REPORT_SIZE));
});

test("keepalives are absorbed; 0x02 up-needed is surfaced as the touch wait; the reply rides the command's own byte", async () => {
  const { dev, t } = await openedTransport();
  const states = [];
  const envelope = new Uint8Array([0xa2, 0x01, 0x19, 0x90, 0x00, 0x02, 0x59, 0x00, 0x20, ...new Uint8Array(32).fill(7)]);
  dev.respond(
    () => replyReports(CID, CMD_KEEPALIVE, new Uint8Array([0x01])),
    () => replyReports(CID, CMD_KEEPALIVE, new Uint8Array([0x02])),
    () => replyReports(CID, NOSTR_CMD.SIGN, envelope),
  );
  const res = await t.vendor(NOSTR_CMD.SIGN, 0, encodeRequest(0, new Uint8Array(32)), {
    onKeepalive: (s) => states.push(s),
  });
  assert.deepEqual(states, ["processing", "up-needed"]);
  assert.equal(res.sw, SW.OK);
  assert.equal(res.upNeeded, true);
  assert.equal(res.data.length, 32);
});

test("a device ERROR frame is a typed failure, not a hang", async () => {
  const { dev, t } = await openedTransport();
  dev.respond(() => replyReports(CID, 0x07, new Uint8Array([0x01])));
  await assert.rejects(
    () => t.vendor(NOSTR_CMD.PING, 0, new Uint8Array(0)),
    (e) => e instanceof CtapError && e.code === CtapErr.DEVICE_ERROR,
  );
});

test("an absent device is typed DEVICE_ABSENT before any framing is attempted", async () => {
  const { t } = { t: new CtapVendorTransport(new FakeDevice()) };
  await assert.rejects(
    () => t.vendor(NOSTR_CMD.SIGN, 0, new Uint8Array(0)),
    (e) => e instanceof CtapError && e.code === CtapErr.DEVICE_ABSENT,
  );
});

test("the request envelope is the device's decode_request form, byte-exact", () => {
  // idx <= 0x17: bare uint. idx 200: 0x18 + byte. idx 1000: 0x19 + u16.
  // arg lengths: 0 -> 0x40, 24 -> 0x58 0x18, 1000 -> 0x59 hi lo.
  assert.deepEqual([...encodeRequest(0, new Uint8Array(0))], [0x82, 0x00, 0x40]);
  assert.deepEqual([...encodeRequest(3, new Uint8Array(24).fill(9))].slice(0, 4), [0x82, 0x03, 0x58, 0x18]);
  assert.deepEqual([...encodeRequest(200, new Uint8Array(0))], [0x82, 0x18, 0xc8, 0x40]);
  assert.deepEqual([...encodeRequest(1000, new Uint8Array(0))], [0x82, 0x19, 0x03, 0xe8, 0x40]);
  const big = encodeRequest(0, new Uint8Array(1000));
  assert.deepEqual(big.slice(1, 5), new Uint8Array([0x00, 0x59, 0x03, 0xe8]));
  assert.equal(big.length, 1 + 1 + 3 + 1000);
});

test("the response decoder is the device's encode_response inverse, both shapes", () => {
  // sw-only: map(1) {1: 0x6985}
  let [sw, data] = decodeResponse(new Uint8Array([0xa1, 0x01, 0x19, 0x69, 0x85]));
  assert.equal(sw, 0x6985);
  assert.equal(data.length, 0);
  // sw + data: map(2) {1: 0x9000, 2: bytes(2)}
  [sw, data] = decodeResponse(new Uint8Array([0xa2, 0x01, 0x19, 0x90, 0x00, 0x02, 0x58, 0x02, 0xaa, 0xbb]));
  assert.equal(sw, 0x9000);
  assert.deepEqual([...data], [0xaa, 0xbb]);
  // malformed shapes decode to null, not to guesses.
  assert.equal(decodeResponse(new Uint8Array([0xa3])), null);
  assert.equal(decodeResponse(new Uint8Array([0xa1, 0x02])), null);
  assert.equal(decodeResponse(new Uint8Array([0xa1, 0x01, 0x1a, 0, 0, 0, 1])), null, "u32 sw is not a shape this vocabulary carries");
});

test("frameReports and the fake device agree on the same header shape for INIT", () => {
  const reports = frameReports(BROADCAST_CID, CMD_INIT, NONCE);
  assert.equal(reports.length, 1);
  assert.deepEqual(reports[0].slice(0, 4), BROADCAST_CID);
  assert.equal(reports[0][4], CMD_INIT | 0x80);
});

test("requestDevice filters on the vendor usage page, not the FIDO one", async () => {
  const seen = [];
  const fakeNavigator = {
    hid: {
      requestDevice: async (opts) => {
        seen.push(opts);
        return [];
      },
    },
  };
  await assert.rejects(() => requestDevice(fakeNavigator), (e) => e.code === CtapErr.DEVICE_ABSENT);
  assert.deepEqual(seen[0].filters, [{ usagePage: USAGE_PAGE, usage: USAGE_ID }]);
});
