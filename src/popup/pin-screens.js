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
 *  only while unlocked. Changing the PIN is always available. US-1748 —
 *  the touch-for-signing checkbox rides the same model, so the screen has
 *  one render path. */
export function manageModel(state) {
  return {
    statusLine: state.unlocked ? 'the session is open' : 'the session is locked',
    canVerify: !state.unlocked,
    canLock: state.unlocked,
    touch: touchPolicyModel(state),
  };
}

/** US-1748 — the touch-policy checkbox, from the parsed GET_INFO state.
 *  Checked = the touch is required for signing (the default and the safe
 *  reading on anything the firmware does not say otherwise — an old board
 *  or a missing state object renders the box checked and disabled, never
 *  as if a bypass were live). Changing the policy is a custody decision:
 *  the board refuses the disable leg without an open session (0x6982), so
 *  a locked one is read-only with the live policy still showing. */
export function touchPolicyModel(state) {
  if (!state || !state.touchSupported) {
    return {
      supported: false,
      unlocked: false,
      requireTouch: true,
      note: 'firmware does not support touch bypass',
    };
  }
  if (!state.unlocked) {
    return {
      supported: true,
      unlocked: false,
      requireTouch: !state.touchBypass,
      note: 'verify the PIN to change this',
    };
  }
  return { supported: true, unlocked: true, requireTouch: !state.touchBypass, note: '' };
}

/** US-1846 — the bypass ledger (GET_AUDIT), from the handler's typed
 *  result. The popup is the user's only window on the bypass state — the
 *  board's LED is not visible from a browser — so every state here is a
 *  plain-words answer to "will the board ask me to touch?": armed with the
 *  operations left, off quietly, or "verify the PIN" when the session is
 *  closed. Neutral states never render as errors. `audit` is the get_audit
 *  handler result, or null when nothing was fetched (no device, no
 *  capability, failed read) — unsupported and unreadable both hide the
 *  block. */
export const AUDIT_VISIBLE_ROWS = 8; // the device keeps 16; the popup caps the list

/** US-1848 — how long one bypass session lives (US-1849's countdown is
 *  measured against it). Mirrors the firmware's `BYPASS_SESSION_MS = 600_000`
 *  (10 minutes from the arm press); the device owns the deadline, this
 *  copy only renders it. */
export const BYPASS_SESSION_MS = 600_000;

/** US-1851 — the remaining session window as `M:SS` (`H:MM:SS` past an
 *  hour). A negative or nonsense input renders as nothing — callers clamp
 *  before they call; the guard is a belt, not the policy. */
export function formatRemaining(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

/** US-1851 — the armed line: how many operations are left and when the
 *  session dies, in one sentence. Shared by the first render and the 1 s
 *  tick, so the countdown can never disagree with itself between the two
 *  render paths. */
export function armedStatusLine(budget, remainingMs) {
  const left = `${budget} operation${budget === 1 ? '' : 's'} left`;
  const exp = formatRemaining(remainingMs);
  return exp
    ? `bypass armed — ${left} · expires in ${exp}`
    : `bypass armed — ${left}`;
}

const AUDIT_OP_WORDS = {
  sign: 'signed',
  nip44_enc: 'encrypted',
  nip44_dec: 'decrypted',
};

/** The device's ts_ms is **monotonic device uptime in milliseconds**
 *  (apps/nostr reads its injected clock — device uptime, not epoch), so a
 *  wall-clock rendering would state a wrong time. The honest display is the
 *  uptime itself: `t+MM:SS` (or `t+H:MM:SS` past an hour). */
export function formatAuditTime(tsMs) {
  if (!Number.isFinite(tsMs) || tsMs < 0) return '';
  const total = Math.floor(tsMs / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `t+${h}:${mm}:${ss}` : `t+${mm}:${ss}`;
}

export function auditModel(audit, elapsedMs = 0) {
  const hidden = { show: false, status: '', rows: [], empty: false, emptyLine: '', armed: false, budget: 0, remainingMs: 0 };
  if (!audit || audit.supported !== true) return hidden;
  if (audit.sessionClosed) {
    return {
      show: true,
      status: 'session closed — verify the PIN to see bypass activity',
      rows: [],
      empty: false,
      emptyLine: '',
      armed: false,
      budget: 0,
      remainingMs: 0,
    };
  }
  const budget = audit.budget ?? 0;
  const armed = budget > 0;
  // US-1851 — the countdown: the device reports the session's sampled age
  // (US-1849); the client eats its own elapsed time off the remaining
  // window between polls. max(0, …): an elapsed past the window reads as
  // expired, never as negative time.
  const ageMs = audit.ageMs ?? 0;
  const remainingMs = armed ? Math.max(0, BYPASS_SESSION_MS - ageMs - elapsedMs) : 0;
  const status = armed
    ? armedStatusLine(budget, remainingMs)
    : 'bypass off — every signature asks for a touch';
  const records = Array.isArray(audit.records) ? audit.records : [];
  const rows = [...records]
    .reverse() // the device answers oldest first; the ledger reads newest first
    .slice(0, AUDIT_VISIBLE_ROWS)
    .map((r) => ({
      op: AUDIT_OP_WORDS[r.op] ?? r.op,
      idx: r.idx,
      ts: r.tsMs,
      time: formatAuditTime(r.tsMs),
      digest: `${String(r.digestHex ?? '').slice(0, 8)}…`,
    }));
  const empty = records.length === 0;
  return { show: true, status, rows, empty, emptyLine: empty ? 'no bypassed operations yet' : '', armed, budget, remainingMs };
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
