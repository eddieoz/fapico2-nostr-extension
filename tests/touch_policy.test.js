// US-1748 — the touch-for-signing policy over SET_TOUCH_POLICY (0x4F). The
// envelope idx rides P1 on the device: 0 re-enables the touch (friction-
// free), 1 disables it for the three signing arms behind the applet's
// refusal ladder — no PIN (6a82), session closed (0x6982, verify first),
// the consent press denied or never given (0x6985). The advertisement is
// GET_INFO's CAP_TOUCH_POLICY (0x0010) and FLAG_TOUCH_BYPASS (0x08), and
// LOCK / a power cycle / a factory wipe clear the flag — the mock models
// LOCK. The popup renders the checkbox from the same parsed state and
// re-renders from pinFlow after any answer, so a refusal snaps the box
// back (the structural pins at the bottom).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NOSTR_CMD, SW } from '../src/core/ctaphid.js';
import { createPinFlow, parseInfoBody, parsePinState } from '../src/worker/pin_flow.js';
import { describeSw } from '../src/worker/error-map.js';
import { createHandlers } from '../src/worker/handlers.js';
import { createDeviceOwner } from '../src/worker/device.js';
import { TRUSTED_ONLY_METHODS, PAGE_ALLOWED_METHODS } from '../src/worker/dispatch.js';
import { MockDevice } from './mock_device.js';
import { touchPolicyModel, manageModel } from '../src/popup/pin-screens.js';

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

/** Install custody and open the session — the state the disable leg needs. */
async function unlockedBoard(handlers, mock, pin = '731742') {
  await call(handlers, 'set_pin', [pin]);
  await call(handlers, 'verify_pin', [pin]);
  assert.equal(mock.unlocked, true);
}

// --- the wire vocabulary ------------------------------------------------------

test('US-1748 SET_TOUCH_POLICY rides vendor byte 0x4f, after CEREMONY_START', () => {
  assert.equal(NOSTR_CMD.SET_TOUCH_POLICY, 0x4f);
  assert.equal(NOSTR_CMD.CEREMONY_START, 0x4e);
});

test('US-1748 the refusal words carry typed sentences', () => {
  assert.match(describeSw(0x6a82).message, /no PIN set/);
  assert.match(describeSw(0x6982).message, /verify/);
  assert.match(describeSw(0x6985).message, /touch/);
});

// --- parsePinState: the advertisement ----------------------------------------

test('US-1748 parsePinState carries the touch facts on custody-firmware info', () => {
  const fresh = parsePinState({ caps: 0x0010, flags: 0x00 });
  assert.equal(fresh.touchSupported, true);
  assert.equal(fresh.touchBypass, false);
  const bypassed = parsePinState({ caps: 0x0010, flags: 0x08 });
  assert.equal(bypassed.touchSupported, true);
  assert.equal(bypassed.touchBypass, true);
});

test('US-1748 old firmware (no CAP_TOUCH_POLICY) reads touchSupported: false, bypass never claimed', () => {
  const old = parsePinState({ caps: 0x0007, flags: 0x03 });
  assert.equal(old.touchSupported, false);
  assert.equal(old.touchBypass, false, 'a flag without its cap is not a live bypass');
  // And bit 3 set without the cap bit still parses the flag honestly —
  // the UI layer (touchPolicyModel) decides what to show.
  const lying = parsePinState({ caps: 0x0007, flags: 0x08 });
  assert.equal(lying.touchSupported, false);
  assert.equal(lying.touchBypass, true);
});

test('US-1748 the touch facts ride every parsePinState branch, unsupported included', () => {
  for (const info of [
    { caps: 0x0003, flags: 0x00 }, // pre-custody generation
    { caps: 0x0007, flags: 0x00 }, // custody, PIN-less
    { caps: 0x001f, flags: 0x03 }, // unlocked custody board
  ]) {
    const s = parsePinState(info);
    assert.equal(typeof s.touchSupported, 'boolean');
    assert.equal(typeof s.touchBypass, 'boolean');
  }
});

// --- the popup model -----------------------------------------------------------

test('US-1748 touchPolicyModel: an unsupported board renders checked, disabled, and says why', () => {
  assert.deepEqual(touchPolicyModel(null), {
    supported: false,
    requireTouch: true,
    note: 'firmware does not support touch bypass',
  });
  assert.deepEqual(touchPolicyModel({ supported: true, touchSupported: false }), {
    supported: false,
    requireTouch: true,
    note: 'firmware does not support touch bypass',
  });
});

test('US-1748 touchPolicyModel: supported boards render the live policy', () => {
  assert.deepEqual(touchPolicyModel({ touchSupported: true, touchBypass: false }), {
    supported: true,
    requireTouch: true,
    note: '',
  });
  assert.deepEqual(touchPolicyModel({ touchSupported: true, touchBypass: true }), {
    supported: true,
    requireTouch: false,
    note: '',
  });
});

test('US-1748 manageModel carries the touch model so the manage screen has one render path', () => {
  const m = manageModel({ unlocked: true, touchSupported: true, touchBypass: false });
  assert.equal(m.touch.requireTouch, true);
  const unsupported = manageModel({ unlocked: false, touchSupported: false });
  assert.equal(unsupported.touch.supported, false);
});

// --- the mock's verb semantics -------------------------------------------------

test('US-1748 the disable leg on a PIN-less board answers 6a82', async () => {
  const mock = new MockDevice();
  const res = await mock.vendor(NOSTR_CMD.SET_TOUCH_POLICY, 1, new Uint8Array(0));
  assert.equal(res.sw, 0x6a82);
  assert.equal(mock.touchBypass, false);
});

test('US-1748 the disable leg on a closed session answers 0x6982 — verify first', async () => {
  const { handlers, mock } = rig();
  await call(handlers, 'set_pin', ['731742']);
  const res = await mock.vendor(NOSTR_CMD.SET_TOUCH_POLICY, 1, new Uint8Array(0));
  assert.equal(res.sw, 0x6982);
  assert.equal(mock.touchBypass, false);
});

test('US-1748 the disable leg with the consent press denied answers 0x6985 and flips nothing', async () => {
  const { handlers, mock } = rig();
  await unlockedBoard(handlers, mock);
  mock.setGrants(false); // the press never comes
  const res = await mock.vendor(NOSTR_CMD.SET_TOUCH_POLICY, 1, new Uint8Array(0));
  assert.equal(res.sw, SW.CONDITIONS_NOT_SATISFIED);
  assert.equal(mock.touchBypass, false);
});

test('US-1748 the disable leg succeeds with session + press, and the flags byte names the bypass', async () => {
  const { handlers, mock } = rig();
  await unlockedBoard(handlers, mock);
  const res = await mock.vendor(NOSTR_CMD.SET_TOUCH_POLICY, 1, new Uint8Array(0));
  assert.equal(res.sw, SW.OK);
  assert.equal(mock.touchBypass, true);
  const info = parseInfoBody((await mock.vendor(NOSTR_CMD.PING, 0, new Uint8Array(0))).data);
  assert.equal(info.caps & 0x0010, 0x0010, 'CAP_TOUCH_POLICY advertised');
  assert.equal(info.flags & 0x08, 0x08, 'FLAG_TOUCH_BYPASS live');
});

test('US-1748 the enable leg (idx 0) is friction-free in every state', async () => {
  // PIN-less, PIN-set-locked, unlocked-with-bypass: idx 0 answers 9000.
  const noPin = new MockDevice();
  assert.equal((await noPin.vendor(NOSTR_CMD.SET_TOUCH_POLICY, 0, new Uint8Array(0))).sw, SW.OK);

  const locked = new MockDevice();
  locked.pin = '731742'; // custody exists, session closed
  assert.equal((await locked.vendor(NOSTR_CMD.SET_TOUCH_POLICY, 0, new Uint8Array(0))).sw, SW.OK);

  const { handlers, mock } = rig();
  await unlockedBoard(handlers, mock);
  await mock.vendor(NOSTR_CMD.SET_TOUCH_POLICY, 1, new Uint8Array(0));
  assert.equal(mock.touchBypass, true);
  const back = await mock.vendor(NOSTR_CMD.SET_TOUCH_POLICY, 0, new Uint8Array(0));
  assert.equal(back.sw, SW.OK);
  assert.equal(mock.touchBypass, false);
  const info = parseInfoBody((await mock.vendor(NOSTR_CMD.PING, 0, new Uint8Array(0))).data);
  assert.equal(info.flags & 0x08, 0, 'the bypass flag is cleared with the touch');
});

test('US-1748 LOCK clears the bypass with the session', async () => {
  const { handlers, mock } = rig();
  await unlockedBoard(handlers, mock);
  await mock.vendor(NOSTR_CMD.SET_TOUCH_POLICY, 1, new Uint8Array(0));
  assert.equal(mock.touchBypass, true);
  await call(handlers, 'lock', []);
  assert.equal(mock.touchBypass, false);
});

test('US-1748 a payload on SET_TOUCH_POLICY is refused 6a80 before anything moves', async () => {
  const mock = new MockDevice();
  const res = await mock.vendor(NOSTR_CMD.SET_TOUCH_POLICY, 0, new Uint8Array([0x01]));
  assert.equal(res.sw, SW.WRONG_DATA);
  assert.equal(mock.touchBypass, false);
});

// --- the handler (trusted-only) ------------------------------------------------

test('US-1748 touch_policy_set frames the wire verb and answers the fresh GET_INFO body', async () => {
  const { handlers, mock } = rig();
  await unlockedBoard(handlers, mock);
  const r = await call(handlers, 'touch_policy_set', [true]);
  assert.equal(mock.calls.at(-2).cmd, NOSTR_CMD.SET_TOUCH_POLICY);
  assert.equal(mock.calls.at(-2).idx, 1, 'disable rides idx 1');
  assert.equal(mock.calls.at(-2).argLen, 0, 'the verb carries no payload');
  assert.equal(mock.calls.at(-1).cmd, NOSTR_CMD.PING, 'a fresh advertisement is read after the change');
  assert.equal(r.info.flags & 0x08, 0x08);
  const r2 = await call(handlers, 'touch_policy_set', [false]);
  assert.equal(mock.calls.at(-2).idx, 0, 'enable rides idx 0');
  assert.equal(r2.info.flags & 0x08, 0);
});

test('US-1748 a non-boolean disable is a typed refusal before any device frame', async () => {
  const { handlers, mock } = rig();
  const before = mock.calls.length;
  for (const bad of [1, 'yes', null, undefined]) {
    await assert.rejects(() => call(handlers, 'touch_policy_set', [bad]), (e) => e.name === 'SignerError');
  }
  assert.equal(mock.calls.length, before, 'the shape refusal never reached the device');
});

test('US-1748 touch_policy_set is trusted-only: a tab sender is forbidden-method', async () => {
  assert.ok(TRUSTED_ONLY_METHODS.has('touch_policy_set'));
  assert.ok(!PAGE_ALLOWED_METHODS.has('touch_policy_set'));
});

// --- the popup wiring (structural pins, no DOM — the pin_screens pattern) -------

test('US-1748 the manage screen renders the checkbox from m.touch and names an unsupported board', async () => {
  const src = await read('src/popup/popup.js');
  assert.match(src, /box\.checked = m\.touch\.requireTouch/);
  assert.match(src, /box\.disabled = !m\.touch\.supported/);
  assert.match(src, /note\.textContent = m\.touch\.note/);
  const html = await read('src/popup/popup.html');
  assert.ok(html.includes('id="pin-manage-touch-row"'), 'the checkbox row exists');
  assert.ok(html.includes('id="pin-manage-touch"'), 'the checkbox exists');
  assert.ok(html.includes('Require touch for signing'), 'the label names what it does');
  assert.ok(html.includes('id="pin-manage-touch-note"'), 'the note element exists');
});

test('US-1748 a refusal re-renders from pinFlow — the checkbox snaps back, the sentence is shown', async () => {
  const src = await read('src/popup/popup.js');
  const handler = src.match(/\$\('pin-manage-touch'\)\.addEventListener\('change'[\s\S]*?\n\}\);/);
  assert.ok(handler, 'the change listener exists');
  const body = handler[0];
  assert.match(body, /api\.call\('touch_policy_set', \[disable\]\)/);
  assert.match(body, /pinFlow\.touchInfoRefreshed\(r\.info\)/, 'success refreshes the advertisement in place');
  assert.match(body, /deviceCallNotice\(err\)/, 'the refusal names its typed sentence');
  const finallyIdx = body.indexOf('finally');
  const renderIdx = body.lastIndexOf('renderPinManage()');
  assert.ok(finallyIdx >= 0 && renderIdx > finallyIdx, 'the re-render runs on every path — success and refusal');
});

test('US-1748 the disable leg is not gated through the PIN resume — it refuses in band', async () => {
  // touch_policy_set is not in the popup's TOUCH_GATED set and not in
  // PIN_METHODS either: the device refuses with 0x6982 and the sentence
  // renders where the checkbox is, no verify-dialog detour.
  const src = await read('src/popup/popup.js');
  const gated = src.match(/const TOUCH_GATED = new Set\(\[([^\]]*)\]\)/);
  assert.ok(gated);
  assert.ok(!gated[1].includes('touch_policy_set'));
  const pinMethods = src.match(/const PIN_METHODS = new Set\(\[([^\]]*)\]\)/);
  assert.ok(pinMethods);
  assert.ok(!pinMethods[1].includes('touch_policy_set'));
});

// --- the flow machine -----------------------------------------------------------

test('US-1748 touchInfoRefreshed refreshes the state in place — pending and surface untouched', () => {
  const flow = createPinFlow();
  flow.connect({ caps: 0x001f, flags: 0x01 }); // PIN set, locked
  flow.gated('sign_event', [{}]);
  const v = flow.touchInfoRefreshed({ caps: 0x001f, flags: 0x09 }); // bypass now live
  assert.equal(v.ui, 'locked', 'the surface did not move');
  assert.deepEqual(flow.pending, { method: 'sign_event', args: [{}] }, 'the pending op survived');
  assert.equal(v.state.touchBypass, true, 'the advertisement moved');
});
