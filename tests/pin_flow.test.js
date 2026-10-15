// US-1706 — the PIN custody flow state machine. The gate can never prompt a
// PIN-less board to set a PIN (it only engages once one exists), so every
// surface here is proactive: read at connect from GET_INFO, never from a
// gate error. The firmware rule that shapes the transitions is the applet's
// own: setting is not unlocking — VERIFY is.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CAP_PIN_MGMT,
  createPinFlow,
  parseInfoBody,
  parsePinState,
  LOCKED_OUT_MESSAGE,
} from '../src/worker/pin_flow.js';

const NEW_FW = { caps: 0x0007, flags: 0x00 }; // custody firmware, PIN-less
const OLD_FW = { caps: 0x0003, flags: 0x00 }; // v0.2.0 — no CAP_PIN_MGMT

test('US-1706 the banner fires on a PIN-less board whose GET_INFO advertises CAP_PIN_MGMT', () => {
  // The trigger the original wording could never satisfy: a gate error is
  // unreachable here, so the offer must come from the connect read.
  const flow = createPinFlow();
  const v = flow.connect(NEW_FW);
  assert.equal(v.ui, 'offer');
  assert.equal(parsePinState(NEW_FW).supported, true);
  assert.equal(parsePinState(NEW_FW).pinSet, false);
});

test('US-1706 old firmware (no CAP_PIN_MGMT) earns no offer and no PIN UI', () => {
  assert.equal(parsePinState(OLD_FW).ui, 'unsupported');
  assert.equal(createPinFlow().connect(OLD_FW).ui, 'unsupported');
});

test('US-1706 connect-banner → set → verify → gated-op-resume', () => {
  const flow = createPinFlow();
  flow.connect(NEW_FW);
  assert.equal(flow.offerAccepted().ui, 'setting');
  // Setting is not unlocking — the firmware keeps the session closed, so
  // the flow goes straight into the verify dialog.
  const v = flow.setOk();
  assert.equal(v.ui, 'locked');
  assert.equal(v.justSet, true);
  // The gated op is kept, not dropped: the user never re-fills a form.
  const g = flow.gated('sign_event', [/* event */ {}]);
  assert.equal(g.ui, 'locked');
  assert.equal(g.gated, true);
  const done = flow.verifyOk();
  assert.equal(done.ui, 'ready');
  assert.deepEqual(done.resume, { method: 'sign_event', args: [{}] });
});

test('US-1706 locked board → verify (attempts counter from 63Cn) → op-resume', () => {
  const flow = createPinFlow();
  flow.connect({ caps: 0x0007, flags: 0x01 }); // PIN set, session closed
  assert.equal(flow.view.ui, 'locked');
  flow.gated('delete_key', [1]);
  const wrong = flow.verifySw(0x63c2); // two attempts left
  assert.equal(wrong.ui, 'locked');
  assert.equal(wrong.attempts, 2);
  assert.equal(wrong.gated, true, 'the pending op survives a wrong try');
  const done = flow.verifyOk();
  assert.deepEqual(done.resume, { method: 'delete_key', args: [1] });
});

test('US-1706 the lockout (63C0) shows the recovery message and drops the pending op', () => {
  const flow = createPinFlow();
  flow.connect({ caps: 0x0007, flags: 0x01 });
  flow.gated('sign_event', []);
  const v = flow.verifySw(0x63c0);
  assert.equal(v.ui, 'locked-out');
  assert.equal(v.message, LOCKED_OUT_MESSAGE);
  assert.match(v.message, /factory reset/);
  assert.match(v.message, /destroys every identity/);
  assert.equal(flow.pending, null);
});

test('US-1706 lock closes the session back into the verify surface', () => {
  const flow = createPinFlow();
  flow.connect({ caps: 0x0007, flags: 0x03 }); // unlocked
  assert.equal(flow.view.ui, 'ready');
  flow.gated('sign_event', []);
  assert.equal(flow.lockOk().ui, 'locked');
  assert.equal(flow.pending, null, 'a lock cancels the pending op — it must be re-gated');
});

test('US-1706 a re-connect starts a fresh surface; a dismissed offer falls back to usable', () => {
  const flow = createPinFlow();
  flow.connect(NEW_FW);
  flow.gated('sign_event', []);
  flow.connect({ caps: 0x0007, flags: 0x03 });
  assert.equal(flow.view.ui, 'ready');
  assert.equal(flow.pending, null);
  const dismissed = createPinFlow();
  dismissed.connect(NEW_FW);
  assert.equal(dismissed.offerDismissed().ui, 'ready');
});

test('US-1706 the GET_INFO body parses: applet_ver, caps, flags, and the 7-byte old shape', () => {
  const body = parseInfoBody(new Uint8Array([0x00, 0x02, 0x00, 0x07, 0x07, 0x00, 0x02, 0x00]));
  assert.deepEqual(body.appletVer, [0x00, 0x02]);
  assert.equal(body.caps, 0x0007);
  assert.equal(body.maxPlaintext, 0x0700);
  assert.equal(body.nIdentities, 2);
  assert.equal(body.flags, 0x00);
  assert.equal(parsePinState(body).ui, 'offer', 'flags bit0 clear = PIN-less, even on new firmware');
  const old = parseInfoBody(new Uint8Array([0x00, 0x01, 0x00, 0x03, 0x07, 0x00, 0x02]));
  assert.equal(old.flags, 0, 'the v0.2.0 body has no flags byte; it defaults to none set');
  assert.equal(parsePinState(old).ui, 'unsupported', 'no CAP_PIN_MGMT bit — the old generation');
});
