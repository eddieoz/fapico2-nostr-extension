// US-1705 — the PIN custody handlers ride the vendor dialect the firmware
// serves: 0x4B VERIFY, 0x4C SET/CHANGE (idx rides P1: 0 = set, 1 =
// change), 0x4D LOCK, the envelope `[idx, arg]` with the PIN in `arg`,
// and the error map translating 63C1..63C3 into attempts-remaining
// sentences, 63C0 into the lockout (recovery = management RESET, stated
// plainly), 0x6982 into the session-required word, and 0x6A82's dual
// reading named.

import test from 'node:test';
import assert from 'node:assert/strict';

import { NOSTR_CMD, SW } from '../src/core/ctaphid.js';
import { describeSw } from '../src/worker/error-map.js';
import { createHandlers } from '../src/worker/handlers.js';
import { createDeviceOwner } from '../src/worker/device.js';
import { MockDevice } from './mock_device.js';

function rig() {
  const mock = new MockDevice();
  const device = createDeviceOwner({
    getGrantedDevice: async () => ({}),
    createTransport: () => mock,
    openTransport: async () => {},
  });
  const handlers = createHandlers({ device });
  return { mock, handlers };
}

const call = async (handlers, method, args) =>
  handlers[method](args, { sender: { url: 'chrome-extension://x/popup.html' }, trusted: true, requestId: 't' });

test('US-1705 the three handlers ride the vendor bytes the firmware maps', async () => {
  const { handlers, mock } = rig();
  await call(handlers, 'set_pin', ['731742']);
  await call(handlers, 'verify_pin', ['731742']);
  await call(handlers, 'lock', []);
  const cmds = mock.calls.map((c) => c.cmd);
  assert.deepEqual(cmds, [NOSTR_CMD.SET_PIN, NOSTR_CMD.VERIFY_PIN, NOSTR_CMD.LOCK]);
  assert.equal(cmds[0], 0x4c);
  assert.equal(cmds[1], 0x4b);
  assert.equal(cmds[2], 0x4d);
});

test('US-1705 the PIN rides `arg` whole; the lock command carries an empty arg', async () => {
  const { handlers, mock } = rig();
  await call(handlers, 'set_pin', ['731742']);
  await call(handlers, 'verify_pin', ['731742']);
  assert.equal(mock.calls[1].argLen, 6, 'the PIN is the whole arg');
  await call(handlers, 'lock', []);
  assert.equal(mock.calls[2].argLen, 0);
  assert.equal(mock.unlocked, false, 'lock dropped the session');
});

test('US-1705 change_pin sends the lc-prefixed payload at idx 1', async () => {
  const { handlers, mock } = rig();
  await call(handlers, 'set_pin', ['731742']);
  await call(handlers, 'change_pin', ['731742', '246813']);
  const set = mock.calls[0];
  const change = mock.calls[1];
  assert.equal(set.cmd, 0x4c);
  assert.equal(set.idx, 0);
  assert.equal(change.cmd, 0x4c);
  assert.equal(change.idx, 1, 'the envelope idx selects the change ceremony');
  // The mock decoded the lc split: the NEW pin verifies, the old one
  // does not — the applet reads `lc ‖ current ‖ new`, never the other way.
  await call(handlers, 'verify_pin', ['246813']);
  assert.equal(mock.pin, '246813');
});

test('US-1705 the wrong-PIN rows surface through the error map with attempts left', async () => {
  const { handlers, mock } = rig();
  await call(handlers, 'set_pin', ['731742']);
  const rows = [];
  for (let i = 0; i < 3; i++) {
    try {
      await call(handlers, 'verify_pin', ['000000']);
      assert.fail('a wrong PIN must throw');
    } catch (err) {
      rows.push(err.sw ?? err.code);
    }
  }
  assert.deepEqual(rows, [0x63c2, 0x63c1, 0x63c0], '63CX rides the error verbatim');
  assert.equal(describeSw(0x63c2).attempts, 2);
  assert.match(describeSw(0x63c2).message, /2 attempts left/);
  assert.match(describeSw(0x63c1).message, /1 attempt left/);
  assert.match(describeSw(0x63c3).message, /3 attempts left/);
  assert.equal(describeSw(0x63c0).code, 'SW_PIN_LOCKED');
  assert.match(describeSw(0x63c0).message, /factory reset/, 'the recovery is stated plainly');
});

test('US-1705 the session-required and not-set words have sentences', async () => {
  assert.equal(describeSw(0x6982).code, 'SW_PIN_SESSION_REQUIRED');
  assert.match(describeSw(0x6982).message, /verify/);
  // 0x6A82 is dual-homed: the identity reading and the PIN reading.
  assert.match(describeSw(0x6a82).message, /no PIN set/);
});

test('US-1705 a PIN-less board: verify says not set, set establishes custody', async () => {
  const { handlers, mock } = rig();
  try {
    await call(handlers, 'verify_pin', ['731742']);
    assert.fail('verify on an unset board must throw');
  } catch (err) {
    assert.equal(err.sw, 0x6a82);
  }
  await call(handlers, 'set_pin', ['731742']);
  await call(handlers, 'verify_pin', ['731742']);
  assert.equal(mock.unlocked, true);
});

test('US-1705 a 5-byte or 97-byte PIN is refused before the wire', async () => {
  const { handlers, mock } = rig();
  const before = mock.calls.length;
  await assert.rejects(() => call(handlers, 'verify_pin', ['12345']), /6\.\.64/);
  await assert.rejects(() => call(handlers, 'set_pin', ['x'.repeat(65)]), /6\.\.64/);
  assert.equal(mock.calls.length, before, 'the shape refusal never reached the device');
});
