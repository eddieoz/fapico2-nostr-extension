// US-1846 — the touch-bypass accounting surface. The firmware carries a
// per-session ledger of the operations the bypass exempted from the press:
// GET_AUDIT (vendor 0x50) answers budget(1) ‖ n(1) ‖ n × { op(1), idx(1),
// ts_ms(4 BE), digest(16) } behind the same custody gate every identity
// command sits behind — a PIN-set board with a closed session answers 0x6982,
// which here is a LEGITIMATE answer ("verify the PIN to see it"), never an
// error to throw. The capability is GET_INFO caps bit 5 (0x0020); the live
// armed state rides flags bit 3 as before (US-1748).
//
// The user's question this surface answers: "will the board ask me to
// touch?" — plain words, no jargon, no alarmist styling for neutral states.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NOSTR_CMD, SW } from '../src/core/ctaphid.js';
import { CAP_BYPASS_ACCOUNTING, parseInfoBody, parsePinState } from '../src/worker/pin_flow.js';
import { createHandlers } from '../src/worker/handlers.js';
import { createDeviceOwner } from '../src/worker/device.js';
import { TRUSTED_ONLY_METHODS, PAGE_ALLOWED_METHODS, createDispatch } from '../src/worker/dispatch.js';
import { MockDevice } from './mock_device.js';
import { auditModel, AUDIT_VISIBLE_ROWS } from '../src/popup/pin-screens.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFile(join(root, p), 'utf8');

function rig() {
  const mock = new MockDevice();
  // An advancing clock keeps the owner's PING rate-limit (1 s window) from
  // tripping when a test reads the advertisement twice in one rig.
  let tick = 0;
  const device = createDeviceOwner({
    getGrantedDevice: async () => ({}),
    createTransport: () => mock,
    openTransport: async () => {},
    now: () => ++tick * 2000,
  });
  const handlers = createHandlers({ device });
  return { mock, handlers };
}

const call = async (handlers, method, args) =>
  handlers[method](args, { sender: { url: 'chrome-extension://x/popup.html' }, trusted: true, requestId: 't' });

/** Install custody and open the session — the state the bypass needs. */
async function unlockedBoard(handlers, mock, pin = '731742') {
  await call(handlers, 'set_pin', [pin]);
  await call(handlers, 'verify_pin', [pin]);
  assert.equal(mock.unlocked, true);
}

// --- the wire vocabulary ------------------------------------------------------

test('US-1846 GET_AUDIT rides vendor byte 0x50, after SET_TOUCH_POLICY', () => {
  assert.equal(NOSTR_CMD.GET_AUDIT, 0x50);
  assert.equal(NOSTR_CMD.SET_TOUCH_POLICY, 0x4f);
});

// --- parsePinState: the advertisement ----------------------------------------

test('US-1846 parsePinState carries auditSupported from caps bit 5', () => {
  const withCap = parsePinState({ caps: 0x0020, flags: 0x00 });
  assert.equal(withCap.auditSupported, true);
  const without = parsePinState({ caps: 0x0010, flags: 0x00 });
  assert.equal(without.auditSupported, false, 'the US-1748 generation does not advertise the ledger');
});

test('US-1846 the audit fact rides every parsePinState branch, unsupported included', () => {
  for (const info of [
    { caps: 0x0003, flags: 0x00 }, // pre-custody generation
    { caps: 0x0007, flags: 0x00 }, // custody, PIN-less
    { caps: 0x003f, flags: 0x03 }, // unlocked custody board with the ledger
  ]) {
    const s = parsePinState(info);
    assert.equal(typeof s.auditSupported, 'boolean');
  }
});

test('US-1846 the mock advertises CAP_BYPASS_ACCOUNTING in its GET_INFO body', async () => {
  const mock = new MockDevice();
  const info = parseInfoBody((await mock.vendor(NOSTR_CMD.PING, 0, new Uint8Array(0))).data);
  assert.equal(info.caps & CAP_BYPASS_ACCOUNTING, CAP_BYPASS_ACCOUNTING);
});

// --- the mock's ledger semantics -----------------------------------------------

test('US-1846 GET_AUDIT on a PIN-less board answers honestly empty (budget 0, n 0)', async () => {
  const mock = new MockDevice();
  const res = await mock.vendor(NOSTR_CMD.GET_AUDIT, 0, new Uint8Array(0));
  assert.equal(res.sw, SW.OK);
  assert.deepEqual([...res.data], [0, 0]);
});

test('US-1846 GET_AUDIT on a closed session answers 0x6982 — the gate, not a fault', async () => {
  const mock = new MockDevice();
  mock.pin = '731742'; // custody exists, session closed
  const res = await mock.vendor(NOSTR_CMD.GET_AUDIT, 0, new Uint8Array(0));
  assert.equal(res.sw, SW.PIN_SESSION_REQUIRED);
});

test('US-1846 arming the bypass loads the budget at 32; the records ring starts empty', async () => {
  const mock = new MockDevice();
  mock.pin = '731742';
  mock.unlocked = true;
  await mock.vendor(NOSTR_CMD.SET_TOUCH_POLICY, 1, new Uint8Array(0));
  const res = await mock.vendor(NOSTR_CMD.GET_AUDIT, 0, new Uint8Array(0));
  assert.equal(res.sw, SW.OK);
  assert.equal(res.data[0], 32);
  assert.equal(res.data[1], 0);
});

test('US-1846 a bypassed SIGN decrements the budget and lands in the ledger, oldest first', async () => {
  const mock = new MockDevice();
  mock.pin = '731742';
  mock.unlocked = true;
  await mock.vendor(NOSTR_CMD.SET_TOUCH_POLICY, 1, new Uint8Array(0));
  const arg = new Uint8Array(32).fill(0xaa);
  await mock.vendor(NOSTR_CMD.SIGN, 0, arg);
  await mock.vendor(NOSTR_CMD.SIGN, 1, arg);
  const res = await mock.vendor(NOSTR_CMD.GET_AUDIT, 0, new Uint8Array(0));
  assert.equal(res.sw, SW.OK);
  assert.equal(res.data[0], 30, 'two bypassed ops, two decrements');
  assert.equal(res.data[1], 2);
  // Record shape: op(1) ‖ idx(1) ‖ ts_ms(4 BE) ‖ digest(16) — 22 bytes.
  assert.equal(res.data.length, 2 + 2 * 22);
  assert.equal(res.data[2], 0x00, 'OP_SIGN');
  assert.equal(res.data[3], 0, 'first record names slot 0');
  assert.equal(res.data[24], 0x00, 'second record is also a SIGN');
  assert.equal(res.data[25], 1, 'second record names slot 1');
});

test('US-1846 NIP-44 arms land their own op tags in the ledger', async () => {
  const mock = new MockDevice();
  mock.pin = '731742';
  mock.unlocked = true;
  await mock.vendor(NOSTR_CMD.SET_TOUCH_POLICY, 1, new Uint8Array(0));
  // The peer is a real x-only pubkey — the NIP-44 path ECDHs against it.
  const peer = mock.pub(1);
  const encArg = new Uint8Array([...peer, ...new Uint8Array(8).fill(0x11)]);
  await mock.vendor(NOSTR_CMD.NIP44_ENCRYPT, 0, encArg);
  const res = await mock.vendor(NOSTR_CMD.GET_AUDIT, 0, new Uint8Array(0));
  assert.equal(res.data[0], 31);
  assert.equal(res.data[2], 0x01, 'OP_NIP44_ENC');
});

test('US-1846 LOCK clears the bypass with the ledger', async () => {
  const { handlers, mock } = rig();
  await unlockedBoard(handlers, mock);
  await mock.vendor(NOSTR_CMD.SET_TOUCH_POLICY, 1, new Uint8Array(0));
  await mock.vendor(NOSTR_CMD.SIGN, 0, new Uint8Array(32).fill(1));
  await call(handlers, 'lock', []);
  const res = await mock.vendor(NOSTR_CMD.GET_AUDIT, 0, new Uint8Array(0));
  assert.equal(res.sw, SW.PIN_SESSION_REQUIRED, 'the lock closed the session too');
  assert.equal(mock.bypassBudget, 0);
  assert.equal(mock.auditRecords.length, 0);
});

// --- the handler (trusted-only) ------------------------------------------------

test('US-1846 get_audit parses the body: budget, records, op words, digest hex', async () => {
  const { handlers, mock } = rig();
  await unlockedBoard(handlers, mock);
  await mock.vendor(NOSTR_CMD.SET_TOUCH_POLICY, 1, new Uint8Array(0));
  const arg = new Uint8Array(32).fill(0xaa);
  await mock.vendor(NOSTR_CMD.SIGN, 0, arg);
  const r = await call(handlers, 'get_audit', []);
  assert.equal(r.supported, true);
  assert.equal(r.sessionClosed, false);
  assert.equal(r.budget, 31);
  assert.equal(r.records.length, 1);
  const rec = r.records[0];
  assert.equal(rec.op, 'sign');
  assert.equal(rec.idx, 0);
  assert.equal(typeof rec.tsMs, 'number');
  assert.equal(rec.tsMs > 0, true, 'the timestamp is a real number, not zero-filled');
  assert.match(rec.digestHex, /^[0-9a-f]{32}$/, 'digest is 16 bytes as hex');
  // The digest is the SHA-256 of the request payload, truncated to 16 bytes.
  const { sha256 } = await import('@noble/hashes/sha2.js');
  const bytesToHex = (await import('@noble/hashes/utils.js')).bytesToHex;
  const expected = bytesToHex(sha256(arg).subarray(0, 16));
  assert.equal(rec.digestHex, expected);
});

test('US-1846 get_audit on a closed session answers sessionClosed — a legitimate state, not an error', async () => {
  const { handlers, mock } = rig();
  await call(handlers, 'set_pin', ['731742']); // custody, session closed
  const r = await call(handlers, 'get_audit', []);
  assert.deepEqual(r, { supported: true, budget: null, records: null, sessionClosed: true });
});

test('US-1846 get_audit on a PIN-less board answers an honest empty ledger', async () => {
  const { handlers } = rig();
  const r = await call(handlers, 'get_audit', []);
  assert.equal(r.supported, true);
  assert.equal(r.budget, 0);
  assert.deepEqual(r.records, []);
  assert.equal(r.sessionClosed, false);
});

test('US-1846 get_audit is trusted-only: a tab sender is forbidden-method', async () => {
  assert.ok(TRUSTED_ONLY_METHODS.has('get_audit'));
  assert.ok(!PAGE_ALLOWED_METHODS.has('get_audit'));
  const { handlers, mock } = rig();
  const route = createDispatch(handlers, { extensionId: 'test' });
  const reply = await route(
    { id: 'p0', method: 'get_audit', args: [] },
    { url: 'https://chat.nostr.com/' },
    null,
  );
  assert.equal(reply.error?.name, 'ForbiddenMethodError');
  assert.equal(mock.calls.length, 0, 'the refused frame never reached the device');
});

// --- the popup model ------------------------------------------------------------

test('US-1846 auditModel: an unsupported board renders nothing at all', () => {
  assert.equal(auditModel(null).show, false);
  assert.equal(auditModel({ supported: false }).show, false);
});

test('US-1846 auditModel: a closed session renders one neutral line, never an error', () => {
  const m = auditModel({ supported: true, sessionClosed: true, budget: null, records: null });
  assert.equal(m.show, true);
  assert.match(m.status, /verify the PIN/);
  assert.deepEqual(m.rows, []);
  assert.equal(m.empty, false);
});

test('US-1846 auditModel: the armed line answers "will I be asked to touch?" in plain words', () => {
  const armed = auditModel({ supported: true, sessionClosed: false, budget: 30, records: [] });
  assert.match(armed.status, /bypass armed/);
  assert.match(armed.status, /30 operations left/);
  const single = auditModel({ supported: true, sessionClosed: false, budget: 1, records: [] });
  assert.match(single.status, /1 operation left/, 'the singular is written out, not "1 operations"');
});

test('US-1846 auditModel: bypass off is a quiet line, not an alarm', () => {
  const off = auditModel({ supported: true, sessionClosed: false, budget: 0, records: [] });
  assert.match(off.status, /bypass off/);
  assert.match(off.status, /every signature asks for a touch/);
});

test('US-1846 auditModel: rows render newest-first with human op names and clipped digests', () => {
  const m = auditModel({
    supported: true,
    sessionClosed: false,
    budget: 28,
    records: [
      { op: 'sign', idx: 0, tsMs: 1700000000000, digestHex: 'a'.repeat(32) },
      { op: 'nip44_enc', idx: 2, tsMs: 1700000001000, digestHex: 'b'.repeat(32) },
      { op: 'nip44_dec', idx: 1, tsMs: 1700000002000, digestHex: 'c'.repeat(32) },
    ],
  });
  assert.equal(m.rows.length, 3);
  assert.equal(m.rows[0].op, 'decrypted', 'newest first');
  assert.equal(m.rows[1].op, 'encrypted');
  assert.equal(m.rows[2].op, 'signed');
  assert.equal(m.rows[2].idx, 0);
  assert.equal(m.rows[2].digest, 'aaaaaaaa…', 'the digest is 8 hex chars + ellipsis');
  assert.equal(typeof m.rows[0].time, 'string');
  assert.ok(m.rows[0].time.length > 0);
});

test('US-1846 auditModel: the ring is capped — 16 kept on the device, fewer shown', () => {
  const records = Array.from({ length: 16 }, (_, i) => ({
    op: 'sign',
    idx: i % 8,
    tsMs: 1700000000000 + i,
    digestHex: 'd'.repeat(32),
  }));
  const m = auditModel({ supported: true, sessionClosed: false, budget: 16, records });
  assert.equal(m.rows.length, AUDIT_VISIBLE_ROWS);
  assert.ok(m.rows.length < 16);
  assert.equal(m.rows[0].ts, 1700000000015, 'the newest record is first');
});

test('US-1846 auditModel: an empty ring says so in plain words', () => {
  const m = auditModel({ supported: true, sessionClosed: false, budget: 32, records: [] });
  assert.equal(m.empty, true);
  assert.match(m.emptyLine, /no bypassed operations yet/);
});

// --- the popup wiring (structural pins, no DOM — the pin_screens pattern) -------

test('US-1846 the manage screen carries the audit block, caps-gated and driven by the model', async () => {
  const html = await read('src/popup/popup.html');
  assert.ok(html.includes('id="pin-manage-audit"'), 'the audit block exists');
  assert.ok(html.includes('id="pin-manage-audit-status"'), 'the status line exists');
  assert.ok(html.includes('id="pin-manage-audit-list"'), 'the ledger list exists');
  assert.ok(html.includes('hidden'), 'the block starts hidden');

  const js = await read('src/popup/popup.js');
  assert.match(js, /api\.call\('get_audit'\)/, 'the popup fetches the ledger');
  assert.match(js, /auditModel\(/, 'the render goes through the pure model');
  assert.match(js, /auditSupported/, 'the fetch is gated on the capability, not shown blind');
  assert.match(js, /refreshAudit\(\)/, 'the manage screen refreshes the ledger');
  const manage = js.match(/function renderPinManage\(\)[\s\S]*?\n\}/);
  assert.ok(manage, 'renderPinManage exists');
  assert.match(manage[0], /refreshAudit\(\)/, 'opening the manage screen reads the ledger');
});

test('US-1846 the touch-policy toggle re-reads the ledger — arming moves the budget line', async () => {
  const js = await read('src/popup/popup.js');
  const handler = js.match(/\$\('pin-manage-touch'\)\.addEventListener\('change'[\s\S]*?\n\}\);/);
  assert.ok(handler, 'the change listener exists');
  assert.match(handler[0], /refreshAudit\(\)/, 'a policy change refreshes the accounting in place');
});
