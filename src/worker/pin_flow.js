// US-1706/US-1707 — the PIN custody flow as a pure state machine.
//
// The gate on the firmware can never prompt a PIN-less board to set a PIN —
// the gate only engages once a PIN exists — so the offer must be
// **proactive**: read at connect time from GET_INFO (the vendor PING maps to
// INS_GET_INFO on the device), not from a gate error. The firmware rule that
// shapes the transitions is apps/nostr's own: *setting is not unlocking —
// VERIFY is* — a successful SET_PIN leaves the session locked, so the set
// ceremony flows straight into the verify dialog.
//
// Everything here is pure: the popup and prompt pages render the view this
// machine returns, and the node tests drive it without a DOM.

/** GET_INFO capability bits (apps/nostr CAP_*). */
export const CAP_KEY_MGMT = 0x0001;
export const CAP_NIP44 = 0x0002;
export const CAP_PIN_MGMT = 0x0004;

/** GET_INFO flags bits (apps/nostr FLAG_*, US-1700). */
export const FLAG_PIN_SET = 0x01;
export const FLAG_SESSION_UNLOCKED = 0x02;

/** The GET_INFO body: applet_ver(2) ‖ caps(2) ‖ max_plaintext(2) ‖
 *  n_identities(1) ‖ flags(1). Pre-custody boards answer 7 bytes — the
 *  flags byte defaults to 0, which is exactly what a v0.2.0 board is. */
export function parseInfoBody(data) {
  if (!data || data.length < 7) return null;
  const flags = data.length >= 8 ? data[7] : 0;
  return {
    appletVer: [data[0], data[1]],
    caps: (data[2] << 8) | data[3],
    maxPlaintext: (data[4] << 8) | data[5],
    nIdentities: data[6],
    flags,
  };
}

/** The connect-time verdict: which PIN surface, if any, this board earns.
 *  `unsupported` is the old-firmware answer — every PIN UI hides (US-1707). */
export function parsePinState(info) {
  const caps = info?.caps ?? 0;
  const flags = info?.flags ?? 0;
  const supported = (caps & CAP_PIN_MGMT) !== 0;
  const pinSet = (flags & FLAG_PIN_SET) !== 0;
  const unlocked = (flags & FLAG_SESSION_UNLOCKED) !== 0;
  if (!supported) return { supported, pinSet, unlocked, ui: 'unsupported' };
  if (!pinSet) return { supported, pinSet, unlocked, ui: 'offer' };
  return { supported, pinSet, unlocked, ui: unlocked ? 'ready' : 'locked' };
}

/** The lockout sentence: recovery is management RESET, stated plainly —
 *  every identity on the board dies with it. */
export const LOCKED_OUT_MESSAGE =
  'the device is locked — too many wrong PINs. ' +
  'Recovery is a factory reset from the management applet, which destroys every identity on the board.';

export function createPinFlow() {
  let view = { ui: 'idle' };
  let pending = null; // {method, args} — the op 0x6982 stopped, awaiting verify

  const show = (v) => (view = v) && v;

  return {
    get view() {
      return view;
    },
    get pending() {
      return pending;
    },

    /** Connect: the proactive read. A re-connect starts a fresh surface —
     *  a pending op does not survive it (the session flag is device-side
     *  and may have moved under us). */
    connect(info) {
      pending = null;
      const state = parsePinState(info);
      return show({ ui: state.ui, state });
    },

    /** The user accepted the first-connect banner. */
    offerAccepted() {
      if (view.ui !== 'offer') return view;
      return show({ ui: 'setting', state: view.state });
    },

    /** The user dismissed the banner. A PIN-less board is fully usable —
     *  the gate never fires — so the surface is the ordinary one, and the
     *  settings row still offers custody later. */
    offerDismissed() {
      if (view.ui !== 'offer') return view;
      return show({ ui: 'ready', state: view.state });
    },

    /** SET_PIN answered 9000. Setting is not unlocking: straight into the
     *  verify dialog. */
    setOk() {
      if (view.ui !== 'setting') return view;
      return show({ ui: 'locked', attempts: 3, justSet: true, state: view.state });
    },

    /** SET_PIN answered SW_PIN_ALREADY_SET (0x6a82) — a stale surface.
     *  Re-read at the next connect; meanwhile the dialog says so. */
    setRefused() {
      return show({ ui: 'locked', attempts: 3, stale: true, state: view.state });
    },

    /** A trusted op died with SW_PIN_SESSION_REQUIRED — the gate engaged.
     *  The op is kept so the user never re-fills a form (op-resume). */
    gated(method, args) {
      pending = { method, args };
      return show({ ui: 'locked', attempts: view.attempts ?? 3, gated: true, state: view.state });
    },

    /** VERIFY answered 9000: the session is open and the gated op resumes
     *  — the caller re-issues `pending` untouched. */
    verifyOk() {
      const resume = pending;
      pending = null;
      return show({ ui: 'ready', resume, state: view.state });
    },

    /** VERIFY answered a refusal. 63Cn names the attempts left; 63C0 is the
     *  floor — locked out, recovery stated plainly. */
    verifySw(sw) {
      if (sw === 0x63c0) {
        pending = null;
        return show({ ui: 'locked-out', message: LOCKED_OUT_MESSAGE, state: view.state });
      }
      if ((sw & 0xfff0) === 0x63c0) {
        const attempts = sw & 0x0f;
        return show({ ui: 'locked', attempts, gated: pending !== null, state: view.state });
      }
      return show({ ui: 'locked', error: sw, state: view.state });
    },

    /** LOCK answered 9000 — the session is closed again. */
    lockOk() {
      pending = null;
      return show({ ui: 'locked', attempts: 3, state: view.state });
    },
  };
}
