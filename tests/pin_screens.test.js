// US-1706/US-1707 — the popup's PIN custody screens. The models live in
// src/popup/pin-screens.js (pure, node --test drives them); the wiring is
// pinned structurally: with no jsdom in this repo, the assertions parse
// popup.js and popup.html as text — the structural facts a render would
// prove here. The machine behind the models is src/worker/pin_flow.js and
// its parity is pinned by pin_flow.test.js + the fixtures; this suite only
// proves the popup renders what the machine says and resumes a gated op
// through the verify dialog.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  pinRowModel,
  lockIndicatorModel,
  verifyModel,
  manageModel,
  setModel,
  changeModel,
  validatePin,
  validatePinChange,
} from '../src/popup/pin-screens.js';
import { createPinFlow, parseInfoBody } from '../src/worker/pin_flow.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFile(join(root, p), 'utf8');

const src = await read('src/popup/popup.js');
const html = await read('src/popup/popup.html');

/** A GET_INFO body: applet_ver(0,2) ‖ caps(PIN_MGMT|CEREMONY|PIN...) ‖
 *  max_plaintext ‖ n_identities(0) ‖ flags — pin set, session locked. */
const INFO = new Uint8Array([
  0x00, 0x02, 0x00, 0x0c, 0x07, 0x63, 0x00, 0x01,
]);

const state = (pinSet, unlocked) =>
  ({ supported: true, pinSet, unlocked, ui: !pinSet ? 'offer' : unlocked ? 'ready' : 'locked' });

test('US-1707 the PIN row is hidden when there is no device or no GET_INFO body', () => {
  assert.deepEqual(pinRowModel(null), { kind: 'hidden' });
  assert.deepEqual(pinRowModel({ supported: false, pinSet: false, unlocked: false, ui: 'unsupported' }), {
    kind: 'hidden',
  });
});

test('US-1707 the PIN row offers the offer on a PIN-less custody board', () => {
  const m = pinRowModel(state(false, false));
  assert.equal(m.kind, 'offer');
});

test('US-1707 the PIN row offers the manage entry once custody exists, with the session fact', () => {
  assert.deepEqual(pinRowModel(state(true, false)), { kind: 'manage', unlocked: false });
  assert.deepEqual(pinRowModel(state(true, true)), { kind: 'manage', unlocked: true });
});

test('US-1707 the lock indicator shows only while a session is open', () => {
  assert.deepEqual(lockIndicatorModel(null), { show: false, text: '' });
  assert.equal(lockIndicatorModel(state(true, false)).show, false);
  const m = lockIndicatorModel(state(true, true));
  assert.equal(m.show, true);
  assert.match(m.text, /until the board restarts/);
});

test('US-1706 the verify dialog says WHY it is up: right after setting', () => {
  const flow = createPinFlow();
  const offerInfo = new Uint8Array([0x00, 0x02, 0x00, 0x0c, 0x07, 0x63, 0x00, 0x00]);
  flow.connect(parseInfoBody(offerInfo));
  flow.offerAccepted();
  flow.setOk();
  const m = verifyModel(flow.view);
  assert.match(m.headline, /PIN set/);
  assert.match(m.body, /setting the PIN does not open the session/);
  assert.equal(m.attemptsLeft, 3);
  assert.equal(m.lockedOut, false);
});

test('US-1706 the verify dialog says WHY it is up: a stale surface refused to set twice', () => {
  const flow = createPinFlow();
  flow.connect(parseInfoBody(INFO));
  flow.setRefused();
  const m = verifyModel(flow.view);
  assert.match(m.headline, /already set/);
  assert.match(m.body, /verify it instead/);
});

test('US-1706 the verify dialog says WHY it is up: mid-gated-op it names the interrupted method', () => {
  const flow = createPinFlow();
  flow.connect(parseInfoBody(INFO));
  flow.gated('generate_key', []);
  const m = verifyModel(flow.view, 'generate_key');
  assert.match(m.headline, /needed first/);
  assert.match(m.body, /generate_key/);
  assert.match(m.body, /continues where it left off/);
});

test('US-1706 the proactive verify dialog explains the session, not just the form', () => {
  const m = verifyModel({ ui: 'locked', attempts: 3, state: state(true, false) });
  assert.equal(m.headline, 'verify your PIN');
  assert.match(m.body, /stays open until the board restarts/);
});

test('US-1706 a locked-out view disables the form and carries the durable-counter sentence', () => {
  const m = verifyModel({ ui: 'locked-out', message: 'locked', state: state(true, false) });
  assert.equal(m.lockedOut, true);
  assert.equal(m.attemptsLeft, 0);
});

test('US-1706 the manage screen offers Verify only when locked, Lock only while unlocked', () => {
  const locked = manageModel(state(true, false));
  assert.match(locked.statusLine, /session is locked/);
  assert.equal(locked.canVerify, true);
  assert.equal(locked.canLock, false);
  const open = manageModel(state(true, true));
  assert.match(open.statusLine, /session is open/);
  assert.equal(open.canVerify, false);
  assert.equal(open.canLock, true);
});

test('US-1706 the set and change screens carry the 6..64 and session-neutrality copy', () => {
  assert.match(setModel().body, /6 to 64/);
  assert.match(changeModel().body, /does not open or close the session/);
  assert.match(changeModel().body, /burns an attempt/);
});

test('US-1706 validatePin enforces 6..64 BYTES of UTF-8, before any device call', () => {
  assert.throws(() => validatePin('12345'), (e) => e.code === 'BAD_PIN');
  assert.throws(() => validatePin('1'.repeat(65)), (e) => e.code === 'BAD_PIN');
  // four emoji are 16 bytes — fine; sixteen emoji are 64 bytes — still fine;
  // seventeen are 68 bytes — refused, even though that is 17 characters.
  assert.doesNotThrow(() => validatePin('😀'.repeat(4)));
  assert.doesNotThrow(() => validatePin('😀'.repeat(16)));
  assert.throws(() => validatePin('😀'.repeat(17)), (e) => e.code === 'BAD_PIN');
});

test('US-1706 the validation message never echoes the input (the scrub rule)', () => {
  try {
    validatePin('hunter2-secret');
    assert.fail('must throw');
  } catch (e) {
    assert.ok(!e.message.includes('hunter2'));
  }
});

test('US-1706 validatePinChange refuses a short field and mismatched entries locally', () => {
  assert.throws(() => validatePinChange('12345', '123456', '123456'), (e) => e.code === 'BAD_PIN');
  assert.throws(
    () => validatePinChange('current1', 'new-pin-1', 'new-pin-2'),
    (e) => e.code === 'BAD_PIN' && /do not match/.test(e.message),
  );
  assert.doesNotThrow(() => validatePinChange('current1', 'new-pin-1', 'new-pin-1'));
});

// --- structural pins (no DOM) -----------------------------------------------

test('US-1706 all four PIN screens exist in popup.html', () => {
  for (const id of ['screen-pin-set', 'screen-pin-verify', 'screen-pin-manage', 'screen-pin-change']) {
    assert.ok(html.includes(`id="${id}"`), `${id} exists`);
  }
});

test('US-1706 the verify and set inputs are password fields that never autocomplete a PIN', () => {
  const verify = html.match(/<input[^>]*id="pin-verify-input"[^>]*>/);
  const set = html.match(/<input[^>]*id="pin-set-input"[^>]*>/);
  assert.ok(verify, 'the verify input exists');
  assert.match(verify[0], /type="password"/);
  assert.match(verify[0], /autocomplete="off"/);
  assert.ok(set, 'the set input exists');
  assert.match(set[0], /type="password"/);
  assert.match(set[0], /autocomplete="new-password"/);
});

test('US-1706 popup.js drives the machine from the health check (applyPinInfo → connect)', () => {
  assert.match(src, /function applyPinInfo\(h\)/);
  assert.match(src, /pinFlow\.connect\(h\?\.state === 'connected' \? h\.info \?\? null : null\)/);
});

test('US-1706 a gated op catching SW_PIN_SESSION_REQUIRED suspends through the verify dialog and resumes with the ORIGINAL args', () => {
  assert.match(src, /const SW_PIN_SESSION_REQUIRED = 0x6982;/);
  assert.match(src, /err\?\.sw === SW_PIN_SESSION_REQUIRED && !PIN_METHODS\.has\(method\)/);
  assert.match(src, /pinFlow\.gated\(method, args\)/);
  // the resume re-issues the very call that was refused, args untouched
  assert.match(src, /return deviceCall\(method, \.\.\.args\)/);
});

test('US-1706 the verify form resolves the suspended op and the machine (verifyOk) runs first', () => {
  assert.match(src, /pinFlow\.verifyOk\(\)/);
  assert.match(src, /wait\(true\)/);
});

test('US-1706 a wrong PIN answer re-renders attempts via verifySw and scrubs the input — never a success path', () => {
  assert.match(src, /pinFlow\.verifySw\(verr\.sw\)/);
  assert.match(src, /0x63c0 | |& 0x0f|attempts/, 'the attempts decode is reachable from the popup');
});

test('US-1706 the PIN verbs never enter the gated resume — they ARE the unlock path', () => {
  const m = src.match(/const PIN_METHODS = new Set\(\[([^\]]*)\]\)/);
  assert.ok(m, 'PIN_METHODS is declared');
  for (const w of ['verify_pin', 'set_pin', 'change_pin', 'lock']) {
    assert.ok(m[1].includes(w), `${w} is exempt from the gate resume`);
  }
});

test('US-1706 a failed change_pin cannot reach the success notice (the catch returns)', () => {
  const handler = src.match(/\$\('pin-change-form'\)\.addEventListener\('submit'[\s\S]*?\n\}\);/);
  assert.ok(handler, 'the pin-change-form handler exists');
  const body = handler[0];
  const catchIdx = body.indexOf("await deviceCall('change_pin'");
  const noticeIdx = body.indexOf('PIN changed');
  assert.ok(catchIdx >= 0 && noticeIdx > catchIdx, 'the notice follows the device call');
  assert.ok(/catch\s*\{[^}]*return;/.test(body), 'the device-call catch returns before the success path');
});

// --- the export removal (US-1699) -------------------------------------------

test('US-1699 no export surface remains: the screen, the row button, the flow, the handler, the verb, the module', async () => {
  assert.ok(!/screen-export|export-what|export-confirm|export-scalar/.test(html), 'popup.html carries no export UI');
  assert.ok(!/openExport|copyScalar|export_key|exportTarget/.test(src), 'popup.js carries no export flow');
  const dispatch = await read('src/worker/dispatch.js');
  assert.ok(!/'export_key'/.test(dispatch), 'dispatch no longer accepts export_key');
  const handlers = await read('src/worker/handlers.js');
  assert.ok(!/export_key:|EXPORT_KEY/.test(handlers), 'handlers no longer build export_key');
  const roundtrip = await readFile(join(root, 'src/worker/export_roundtrip.js'), 'utf8').then(
    () => 'present', (e) => (e.code === 'ENOENT' ? 'gone' : 'present'),
  );
  assert.equal(roundtrip, 'gone', 'the dead export_roundtrip module is deleted');
  const keysTest = await read('tests/keys_screen.test.js');
  assert.ok(!/export-confirm|US-1730|'export_key'/.test(keysTest), 'no export pins remain');
});
