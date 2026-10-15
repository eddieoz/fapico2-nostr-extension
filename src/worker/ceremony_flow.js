// US-1715/US-1716 — the custody-migration ceremony flow as a pure state
// machine, in the pin_flow.js pattern. The firmware refuses to burn
// implicitly (VERIFY never triggers it — the explicit CEREMONY_START verb
// is the only arm that writes), so the offer must be **proactive**: read at
// connect time from GET_INFO, re-offered at every connect, and a declined
// offer sends nothing irreversible — a persistent, dismissible banner.
//
// The dialog discloses in a fixed order (what the ceremony does →
// irreversibility → the duration bound → "leave it plugged in; the button
// is not needed" → the forgotten-PIN consequence → the one threat-model
// sentence), because an irreversible operation deserves its facts in the
// order a user needs them. The threat-model ceilings stay in the docs; the
// dialog carries only the one sentence.
//
// Everything here is pure: the popup renders the view this machine returns,
// and the node tests drive it without a DOM. The timer is injectable (`now`)
// so the elapsed-against-bound behavior is testable without waiting.

import { RECOVERY_LADDER } from './error-map.js';

/** GET_INFO capability bit (apps/nostr CAP_CEREMONY, US-1714). */
export const CAP_CEREMONY = 0x0008;

/** GET_INFO flags bit 2 (apps/nostr FLAG_MIGRATION_PENDING): PIN set, and
 *  the reseat marker does not stand — the records are still extractable by
 *  the old image, and the ceremony has something to do. */
export const FLAG_MIGRATION_PENDING = 0x04;

// The duration bound printed in the dialog. **A conservative upper bound,
// not the measurement** — the hardware session (US-1718's matrix,
// fapico2 docs/audits/2026-10-15-nostr-downgrade-matrix.md) measured 0.62 s
// for the completing run on real board hardware, so 60 s keeps ~96×
// headroom. Kept as an upper bound on purpose: a virgin-page ceremony adds
// the nine OTP burns, and slower board variants get the same dialog.
export const CEREMONY_BOUND_SECONDS = 60;

// The one user-facing threat-model sentence (US-1716). The ceilings
// themselves are argued in the docs, not here.
export const THREAT_SENTENCE =
  'Set your PIN, keep the board physically yours, and know that a determined expert ' +
  'with custom firmware — or your forgotten PIN — is still the end of these identities.';

// The dialog disclosure, in the order US-1716 fixes. Every line states one
// fact; nothing irreversible happens before the user accepts.
export function disclosureLines() {
  return [
    'the ceremony seals every identity on the board with a device-bound key — one-time, permanent protection against old-firmware extraction',
    'it is irreversible: once run, the identities can never be read by the old firmware again',
    `it takes at most ${CEREMONY_BOUND_SECONDS} seconds — leave the board plugged in; the button is not needed`,
    'if you ever forget this PIN: generated identities are unrecoverable, imported identities come back from your backup file',
    THREAT_SENTENCE,
  ];
}

export { RECOVERY_LADDER };

/** The connect-time verdict: is there a ceremony to offer on this board?
 *  `supported` is the new-firmware answer (CAP_CEREMONY advertised);
 *  `pending` means FLAG_MIGRATION_PENDING — PIN set, marker absent. A
 *  board that is not both is either old firmware (no ceremony exists) or
 *  already sealed (nothing to do). */
export function parseMigrationState(info) {
  const caps = info?.caps ?? 0;
  const flags = info?.flags ?? 0;
  const supported = (caps & CAP_CEREMONY) !== 0;
  const pending = (flags & FLAG_MIGRATION_PENDING) !== 0;
  return { supported, pending, offered: supported && pending };
}

// The banner text a declined offer leaves behind — persistent, dismissible,
// and re-offered at every connect (US-1715's "stays legacy-sealed by their
// own recorded choice").
export const DEFERRED_NOTICE =
  'the identities on this board are still readable by the old firmware — the sealing ceremony remains available';

export function createCeremonyFlow({ now = () => Date.now() } = {}) {
  let view = { ui: 'idle' };
  let startAt = 0;
  // The gated op that was interrupted by the offer (or arrived while the
  // dialog was up) — resumed once the ceremony completes, untouched.
  let pending = null;

  const show = (v) => (view = v);

  return {
    get view() {
      return view;
    },
    get pending() {
      return pending;
    },

    /** Connect: the proactive read. A pending board is re-offered at EVERY
     *  connect — "Not now" records a dismissal, never a decision. An op
     *  that died on 0x6982 survives a connect (the session flag is
     *  device-side and may not have moved), so it rides in and resumes on
     *  completion. */
    connect(info, gatedOp = null) {
      const state = parseMigrationState(info);
      if (gatedOp) pending = gatedOp;
      if (!state.offered) {
        return show({ ui: pending ? 'ready' : 'idle', state });
      }
      return show({ ui: 'offer', state, disclosure: disclosureLines() });
    },

    /** "Migrate now": the irreversible arm — the machine can only note the
     *  run started; the caller sends CEREMONY_START. The timer starts now. */
    offerAccepted() {
      if (view.ui !== 'offer') return view;
      startAt = now();
      return show({ ui: 'running', startedAt: startAt, bound: CEREMONY_BOUND_SECONDS, elapsed: 0 });
    },

    /** The elapsed clock, read whenever the UI wants it. Seconds, floored,
     *  so the display ticks whole. */
    elapsedSeconds() {
      if (view.ui !== 'running') return 0;
      return Math.floor((now() - startAt) / 1000);
    },

    /** A timer tick: the view carries the fresh elapsed count so the
     *  popup just renders it. Over the bound it keeps counting — a bound
     *  exceeded is information ("it is still working"), not an error. */
    tick() {
      if (view.ui !== 'running') return view;
      return show({ ...view, elapsed: Math.floor((now() - startAt) / 1000) });
    },

    /** CEREMONY_START answered 9000: the body is migrated(2 BE) ‖
     *  already(2 BE). The gated op resumes — it was the reason the dialog
     *  came up in the first place, if it came up mid-operation. */
    ceremonyOk(data) {
      const migrated = data.length >= 2 ? (data[0] << 8) | data[1] : null;
      const already = data.length >= 4 ? (data[2] << 8) | data[3] : null;
      const resume = pending;
      pending = null;
      return show({ ui: 'ready', migrated, already, resume, state: { ...view.state, pending: false } });
    },

    /** 0x6F02 — the ceremony has nothing to do (no PIN, no sealed records,
     *  or already sealed). The flags said otherwise; the device is the
     *  authority. The gated op resumes the ordinary way. */
    ceremonyNotNeeded() {
      const resume = pending;
      pending = null;
      return show({ ui: 'ready', needed: false, resume, state: { ...view.state, pending: false } });
    },

    /** 0x6F00 during the run — interrupted-retryable. What the ceremony
     *  finished is kept; running it again completes it. The retry is
     *  offered through THIS dialog at the next connect — never embedded
     *  silently in an unrelated sign operation. */
    ceremonyInterrupted() {
      return show({ ui: 'interrupted', ladder: RECOVERY_LADDER, interrupted: true });
    },

    /** 0x6F01 — the board is sealed-unavailable: every command is refused
     *  from RAM-only. The ladder is stepped, RESET last. */
    sealedUnavailable() {
      return show({ ui: 'sealed', ladder: RECOVERY_LADDER });
    },

    /** "Not now": nothing irreversible, the persistent dismissible banner,
     *  and the ordinary usable surface. */
    offerDismissed() {
      if (view.ui !== 'offer') return view;
      const resume = pending;
      pending = null;
      return show({ ui: 'deferred', notice: DEFERRED_NOTICE, resume });
    },

    /** The banner itself dismissed — the surface is ordinary until the
     *  next connect re-offers. */
    bannerDismissed() {
      if (view.ui !== 'deferred') return view;
      return show({ ui: 'ready' });
    },
  };
}
