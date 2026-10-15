// US-1706/US-1707 — the popup's PIN custody view models, in the keys.js
// pattern: no DOM, no chrome — node --test drives this. The state source is
// the pin flow machine (src/worker/pin_flow.js): the popup feeds it the
// GET_INFO body at every connect and renders what the machine's view says.
// Nothing here talks to the device; every model is a pure map from machine
// state to the copy and button enablement a screen shows.

import { LOCKED_OUT_MESSAGE } from '../worker/pin_flow.js';

/** US-1707 — the keys-home PIN row: which custody surface, if any, this
 *  board earns. `state` is the machine's parsed state (or null when no
 *  device / no GET_INFO body): hidden on an unsupported board, the offer
 *  while no PIN is set, the manage entry once custody exists. */
export function pinRowModel(state) {
  if (!state || !state.supported) return { kind: 'hidden' };
  if (!state.pinSet) return { kind: 'offer' };
  return { kind: 'manage', unlocked: state.unlocked };
}

/** US-1707 — the device card's lock indicator: shown only while a session
 *  is open, because that is the one custody fact the user can act on
 *  ("it stays open until the board restarts"). */
export function lockIndicatorModel(state) {
  if (!state || !state.supported || !state.pinSet || !state.unlocked) {
    return { show: false, text: '' };
  }
  return { show: true, text: 'unlocked — until the board restarts' };
}

/** US-1706 — the verify screen's copy, from the machine's view. The four
 *  arrivals name why the dialog is up: right after setting (setting is not
 *  unlocking — VERIFY is), on a stale surface (the board says a PIN is
 *  already set), mid-gated-op (the interrupted operation is named so the
 *  user knows the form they were filling resumes), or the ordinary
 *  proactive verify. `pendingMethod` is the gated op's method word or null.
 *  A locked-out view disables the form — the counter is durable and zero;
 *  no attempt can succeed. */
export function verifyModel(view, pendingMethod = null) {
  if (view.ui === 'locked-out') {
    return {
      headline: 'the device is locked',
      body: view.message ?? LOCKED_OUT_MESSAGE,
      attemptsLeft: 0,
      lockedOut: true,
    };
  }
  let headline;
  let body;
  if (view.justSet) {
    headline = 'PIN set';
    body = 'setting the PIN does not open the session — verify it now to unlock signing';
  } else if (view.stale) {
    headline = 'a PIN is already set on this board';
    body = 'verify it instead — the device refused to set a second one';
  } else if (view.gated && pendingMethod) {
    headline = 'your PIN is needed first';
    body = `verify and the “${pendingMethod}” you started continues where it left off`;
  } else {
    headline = 'verify your PIN';
    body = 'the PIN opens the signing session — it stays open until the board restarts';
  }
  return {
    headline,
    body,
    attemptsLeft: view.attempts ?? null,
    lockedOut: false,
  };
}

/** US-1706 — the manage screen's buttons: Verify only when locked, Lock
 *  only while unlocked. Changing the PIN is always available. */
export function manageModel(state) {
  return {
    statusLine: state.unlocked ? 'the session is open' : 'the session is locked',
    canVerify: !state.unlocked,
    canLock: state.unlocked,
  };
}

/** US-1706 — the set screen's static copy. */
export function setModel() {
  return {
    title: 'Set a PIN',
    body: 'a PIN guards every key on the board: signing asks for it after each restart, and too many wrong tries lock the device. 6 to 64 characters.',
  };
}

/** US-1706 — the change screen's static copy; the session note is the
 *  firmware's own rule (a change never opens or closes a session). */
export function changeModel() {
  return {
    title: 'Change PIN',
    body: 'the current PIN is verified first — a wrong one burns an attempt, exactly like a wrong unlock. Changing the PIN does not open or close the session. 6 to 64 characters.',
  };
}

/** US-1706 — local validation BEFORE any device call, in the import flow's
 *  scrub style: the message names the problem, never the input. The rule is
 *  the applet's own: 6..64 bytes of UTF-8. */
export function validatePin(pin) {
  const bytes = new TextEncoder().encode(String(pin ?? ''));
  if (bytes.length < 6 || bytes.length > 64) {
    throw Object.assign(
      new Error(`the PIN is ${bytes.length} bytes — the device takes 6 to 64`),
      { name: 'SignerError', code: 'BAD_PIN' },
    );
  }
  return bytes;
}

/** US-1706 — the change form's local rule: all three fields pin-shaped, and
 *  the two entries of the new PIN must agree before the device is asked. */
export function validatePinChange(current, next, confirm) {
  validatePin(current);
  validatePin(next);
  validatePin(confirm);
  if (next !== confirm) {
    throw Object.assign(new Error('the two new-PIN entries do not match'), {
      name: 'SignerError',
      code: 'BAD_PIN',
    });
  }
}
