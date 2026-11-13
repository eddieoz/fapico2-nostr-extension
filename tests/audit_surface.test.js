// US-1846 — the touch-bypass accounting surface. The firmware carries a
// per-session ledger of the operations the bypass exempted from the press:
// GET_AUDIT (vendor 0x50) answers, since US-1849's v0.3 body,
// budget(1) ‖ n(1) ‖ age_ms(4 BE) ‖ n × { op(1), idx(1), ts_ms(4 BE),
// digest(16) } behind the same custody gate every identity
// command sits behind — a PIN-set board with a closed session answers 0x6982,
// which here is a LEGITIMATE answer ("verify the PIN to see it"), never an
// error to throw. The capability is GET_INFO caps bit 5 (0x0020); the live
// armed state rides flags bit 3 as before (US-1748).
//
// US-1848/1851/1852 — the owner's live-test follow-up: the budget is 128,
// the armed status line carries a live countdown from the sampled age, and
// the bypass checkbox reads the device's fresh answer, not the cached view.
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
import { auditModel, armedStatusLine, formatRemaining, AUDIT_VISIBLE_ROWS } from '../src/popup/pin-screens.js';

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

test('US-1846 GET_AUDIT on a PIN-less board answers honestly empty (budget 0, n 0, age 0)', async () => {
  const mock = new MockDevice();
  const res = await mock.vendor(NOSTR_CMD.GET_AUDIT, 0, new Uint8Array(0));
  assert.equal(res.sw, SW.OK);
  assert.deepEqual([...res.data], [0, 0, 0, 0, 0, 0]);
});

test('US-1846 GET_AUDIT on a closed session answers 0x6982 — the gate, not a fault', async () => {
  const mock = new MockDevice();
  mock.pin = '731742'; // custody exists, session closed
  const res = await mock.vendor(NOSTR_CMD.GET_AUDIT, 0, new Uint8Array(0));
  assert.equal(res.sw, SW.PIN_SESSION_REQUIRED);
});

test('US-1855 arming the bypass loads the budget at 255; the records ring starts empty', async () => {
  const mock = new MockDevice();
  mock.pin = '731742';
  mock.unlocked = true;
  await mock.vendor(NOSTR_CMD.SET_TOUCH_POLICY, 1, new Uint8Array(0));
  const res = await mock.vendor(NOSTR_CMD.GET_AUDIT, 0, new Uint8Array(0));
  assert.equal(res.sw, SW.OK);
  assert.equal(res.data[0], 255, "the 1-byte budget field's largest count");
  assert.equal(res.data[1], 0);
  assert.equal(((res.data[2] << 24) | (res.data[3] << 16) | (res.data[4] << 8) | res.data[5]) >>> 0, 0,
    'a fresh arm samples age 0');
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
  assert.equal(res.data[0], 253, 'two bypassed ops, two decrements of 255');
  assert.equal(res.data[1], 2);
  // Record shape: budget(1) ‖ n(1) ‖ age_ms(4) then op(1) ‖ idx(1) ‖
  // ts_ms(4 BE) ‖ digest(16) — 22 bytes per record from offset 6.
  assert.equal(res.data.length, 6 + 2 * 22);
  assert.equal(res.data[6], 0x00, 'OP_SIGN');
  assert.equal(res.data[7], 0, 'first record names slot 0');
  assert.equal(res.data[28], 0x00, 'second record is also a SIGN');
  assert.equal(res.data[29], 1, 'second record names slot 1');
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
  assert.equal(res.data[0], 254);
  assert.equal(res.data[6], 0x01, 'OP_NIP44_ENC');
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
  assert.equal(r.budget, 254);
  assert.equal(typeof r.ageMs, 'number', 'US-1849 — the sampled age rides the parse');
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
  assert.deepEqual(r, { supported: true, budget: null, ageMs: null, records: null, sessionClosed: true });
});

test('US-1846 get_audit on a PIN-less board answers an honest empty ledger', async () => {
  const { handlers } = rig();
  const r = await call(handlers, 'get_audit', []);
  assert.equal(r.supported, true);
  assert.equal(r.budget, 0);
  assert.equal(r.ageMs, 0, 'no session, no age');
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

test('US-1846 the timestamp renders as device uptime, never as wall clock', async () => {
  const { formatAuditTime } = await import('../src/popup/pin-screens.js');
  // The device's ts_ms is monotonic uptime (apps/nostr reads its injected
  // clock) — a Date() rendering would state a wrong local time.
  assert.equal(formatAuditTime(0), 't+00:00');
  assert.equal(formatAuditTime(65_000), 't+01:05');
  assert.equal(formatAuditTime(3_723_000), 't+1:02:03', 'past an hour the hours show');
  assert.equal(formatAuditTime(-1), '', 'a negative is nonsense and renders as nothing');
});

// --- US-1851 — the countdown ----------------------------------------------------

test('US-1851 formatRemaining counts down as M:SS (H:MM:SS past an hour)', () => {
  assert.equal(formatRemaining(600_000), '10:00', 'the full window');
  assert.equal(formatRemaining(383_000), '6:23', 'seconds floor, minutes unpadded');
  assert.equal(formatRemaining(0), '0:00', 'expired reads as zero, never as a negative');
  assert.equal(formatRemaining(3_723_000), '1:02:03', 'past an hour the hours show');
  assert.equal(formatRemaining(-5), '', 'nonsense renders as nothing');
  assert.equal(formatRemaining(NaN), '', 'nonsense renders as nothing');
});

test('US-1851 the armed line names the budget and the deadline in one sentence', () => {
  const line = armedStatusLine(87, 383_000);
  assert.match(line, /bypass armed/);
  assert.match(line, /87 operations left/);
  assert.match(line, /expires in 6:23/);
  const single = armedStatusLine(1, 600_000);
  assert.match(single, /1 operation left/, 'the singular is written out');
  assert.match(single, /expires in 10:00/);
});

test('US-1851 auditModel: the armed model carries the countdown the tick re-renders', () => {
  const m = auditModel({ supported: true, sessionClosed: false, budget: 128, ageMs: 100_000, records: [] });
  assert.equal(m.armed, true, 'budget > 0 *means* armed — the firmware invariant');
  assert.equal(m.budget, 128);
  assert.equal(m.remainingMs, 500_000, 'window minus the sampled age');
  assert.match(m.status, /expires in 8:20/);
  // The tick's math: elapsed host time eats into the remaining window.
  const later = auditModel({ supported: true, sessionClosed: false, budget: 128, ageMs: 100_000, records: [] }, 5_000);
  assert.equal(later.remainingMs, 495_000, 'elapsed between polls counts against the window');
  assert.match(later.status, /expires in 8:15/);
});

test('US-1851 auditModel: elapsed past the window clamps at zero, never negative', () => {
  const m = auditModel({ supported: true, sessionClosed: false, budget: 4, ageMs: 599_000, records: [] }, 5_000);
  assert.equal(m.remainingMs, 0, 'clamped, not negative');
  assert.match(m.status, /expires in 0:00/, 'the honest edge, rendered');
});

test('US-1851 auditModel: bypass off carries no countdown at all', () => {
  const off = auditModel({ supported: true, sessionClosed: false, budget: 0, ageMs: 0, records: [] });
  assert.equal(off.armed, false);
  assert.equal(off.remainingMs, 0);
  assert.doesNotMatch(off.status, /expires in/);
});

test('US-1851 the mock surfaces the sampled age and a dead session reads age 0', async () => {
  const mock = new MockDevice();
  mock.pin = '731742';
  mock.unlocked = true;
  await mock.vendor(NOSTR_CMD.SET_TOUCH_POLICY, 1, new Uint8Array(0));
  mock.bypassAgeMs = 432_000;
  let res = await mock.vendor(NOSTR_CMD.GET_AUDIT, 0, new Uint8Array(0));
  assert.equal(((res.data[2] << 24) | (res.data[3] << 16) | (res.data[4] << 8) | res.data[5]) >>> 0, 432_000);
  // Spent: the disarm leg (idx 0) ends the armed session — age reads 0.
  await mock.vendor(NOSTR_CMD.SET_TOUCH_POLICY, 0, new Uint8Array(0));
  res = await mock.vendor(NOSTR_CMD.GET_AUDIT, 0, new Uint8Array(0));
  assert.equal(((res.data[2] << 24) | (res.data[3] << 16) | (res.data[4] << 8) | res.data[5]) >>> 0, 0,
    'no session, no age — the firmware rule the mirror keeps');
});

test('US-1851 the countdown tick dies with its screen and re-asks the device at zero', async () => {
  const js = await read('src/popup/popup.js');
  assert.match(js, /startAuditTick\(/, 'the tick advances the line between polls');
  assert.match(js, /stopAuditTick\(\)/, '…and is stopped, not leaked');
  const tick = js.match(/function startAuditTick\(\w+\)[\s\S]*?\n\}/);
  assert.match(tick[0], /remaining > 0/, 'between polls the host clock advances the line');
  assert.match(tick[0], /refreshAudit\(\)/, 'at zero the device is re-asked, never trusted locally');
  const back = js.match(/\$\('pin-manage-back'\)\.addEventListener\('click'[\s\S]*?\n\}\);/);
  assert.match(back[0], /stopAuditTick/, 'leaving the manage screen stops the countdown');
});

// --- US-1852 — the checkbox's single source of truth ----------------------------

test('US-1852 the bypass checkbox renders the device word first, the cache only until it speaks', async () => {
  const js = await read('src/popup/popup.js');
  assert.match(js, /latestAudit/, 'the fresh device answer is held, not discarded');
  assert.match(js, /renderTouchCheckbox\(\)/, 'the checkbox renders through one function');
  const fn = js.match(/function renderTouchCheckbox\(\)[\s\S]*?\n\}/);
  assert.ok(fn, 'renderTouchCheckbox exists');
  assert.match(fn[0], /budget > 0/, 'checked = the bypass is active — budget>0 *means* armed');
  assert.match(fn[0], /sessionClosed/, 'a closed session can only mean the bypass is gone');
});

test('US-1852/1853 the label names the state the checkbox shows, both ways', async () => {
  const html = await read('src/popup/popup.html');
  assert.ok(html.includes('id="pin-manage-touch-label"'), 'the label is a rendered element, not static copy');
  assert.doesNotMatch(html, /Require touch for signing/, 'the inverted-cached label is gone');
  const js = await read('src/popup/popup.js');
  // US-1853 — the owner's words, both states: a static "active" label over
  // an unchecked box lied twice a day.
  assert.match(js, /Bypass active — signatures run without a touch/);
  assert.match(js, /Bypass not active — signatures need a touch/);
  assert.match(js, /box\.checked \? TOUCH_LABELS\.on : TOUCH_LABELS\.off/,
    'the label renders from the effective state, whatever source set it');
});

test('US-1853 the change leg arms on CHECK — the polarity follows the semantics', async () => {
  // The owner's blink: US-1852 flipped the checkbox to checked = bypass
  // active but left the old `disable = !box.checked` wiring, so CHECKING
  // sent the disarm direction (a silent no-op) and the fresh read snapped
  // the box back. The wire mapping is touch_policy_set(true) = arm, so the
  // checked state IS the arm direction — same value, no inversion.
  const js = await read('src/popup/popup.js');
  const handler = js.match(/\$\('pin-manage-touch'\)\.addEventListener\('change'[\s\S]*?\n\}\);/);
  assert.ok(handler, 'the change listener exists');
  const body = handler[0];
  assert.match(body, /const arm = box\.checked/,
    'checked = bypass active = the arm direction — no negation left to invert');
  assert.match(body, /api\.call\('touch_policy_set', arm\)/,
    'the flag rides the variadic call bare, pointing at arm');
  assert.match(body, /if \(arm\) touch\(true/,
    'the consent press belongs to the ARM leg — the board is waiting and the wait must be legible');
  assert.doesNotMatch(body, /renderPinManage\(\)/,
    'the finally renders from one fresh device read, not a cached re-render before it');
  assert.match(body, /await refreshAudit\(\)/,
    'the outcome renders from the device word — no stale flash between toggle and truth');
});

test('US-1853 the armed status sits with the toggle it describes', async () => {
  const html = await read('src/popup/popup.html');
  // The status line renders next to the checkbox (before the ledger block),
  // so "bypass armed — N left · expires in M:SS" answers the label directly.
  const statusIdx = html.indexOf('id="pin-manage-audit-status"');
  const rowIdx = html.indexOf('id="pin-manage-touch-row"');
  const blockIdx = html.indexOf('id="pin-manage-audit"');
  assert.ok(statusIdx > rowIdx && statusIdx < blockIdx,
    'the status line lives between the checkbox row and the ledger block');
  const js = await read('src/popup/popup.js');
  assert.match(js, /status\.hidden = !m\.armed && !audit\.sessionClosed/,
    'armed (or gate-closed) shows the status; a plain-off session needs no second sentence');
});

test('US-1854 a board predating the status line says so, instead of hiding silently', async () => {
  const js = await read('src/popup/popup.js');
  // The owner navigated every screen and found nothing: the capability
  // gate hid the block without a word. A stale body (or missing
  // capability) now renders one quiet, actionable line under the toggle.
  const fn = js.match(/async function refreshAudit\(\)[\s\S]*?\n\}/);
  assert.ok(fn, 'refreshAudit exists');
  const gate = fn[0].match(/if \(!pinFlow\.view\.state\?\.auditSupported \|\| !pinFlow\.view\.state\?\.auditBodyV3\)[\s\S]*?\n    return;\n  \}/);
  assert.ok(gate, 'the gate covers BOTH stale shapes: no capability, and a v0.2 body');
  assert.match(gate[0], /status\.hidden = false/, 'the notice renders');
  assert.match(gate[0], /firmware/, 'the notice names the fix — the firmware, not a fault');
  assert.match(gate[0], /renderTouchCheckbox\(\)/, 'the toggle still renders from cache — the policy works on old firmware');
});

test('US-1853 review: the failure paths render the toggle and never freeze a stale status', async () => {
  const js = await read('src/popup/popup.js');
  const fn = js.match(/async function refreshAudit\(\)[\s\S]*?\n\}/);
  assert.ok(fn, 'refreshAudit exists');
  const body = fn[0];
  // Both early-return paths owe the checkbox its enabled/disabled render —
  // the box is disabled at the start of its own change flight and only
  // renderTouchCheckbox re-enables it.
  // US-1854 widened the gate (auditBodyV3 joined it) — the render obligation
  // is the same either way: the toggle re-renders, no stuck box.
  const unsupported = body.match(/if \(!pinFlow\.view\.state\?\.auditSupported \|\| !pinFlow\.view\.state\?\.auditBodyV3\)[\s\S]*?\n  \}/);
  assert.match(unsupported[0], /renderTouchCheckbox\(\)/,
    'a board without the accounting capability still toggles the policy — no stuck box');
  const caught = body.match(/catch \{[\s\S]*?\n  \}/);
  assert.match(caught[0], /status\.hidden = true/, 'a failed read hides the armed line — never frozen');
  assert.match(caught[0], /renderTouchCheckbox\(\)/, 'a failed read re-renders the toggle');
  // And every screen exit from the manage surface stops the countdown.
  const change = js.match(/\$\('pin-manage-change'\)\.addEventListener\('click'[\s\S]*?\n\}\);/);
  assert.match(change[0], /stopAuditTick/, 'leaving via Change-PIN stops the tick too');
});
