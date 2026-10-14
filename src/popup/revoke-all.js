// US-1732 — the "Revoke all" confirmation is a two-step arm, not a blocking
// dialog (window.confirm is unreliable in action popups). The first click arms
// the action and starts a short countdown; a second click inside that window
// confirms, and clicking elsewhere or letting the countdown expire disarms.
// The arm/disarm/confirm state lives here, clock-driven, so the two-step flow
// can be tested without jsdom — popup.js only wires the DOM to it.

/**
 * A two-step arm for one destructive action.
 * @param {object} [opts]
 * @param {() => number} [opts.now] monotonic clock (default Date.now)
 * @param {number} [opts.ms] confirm window in ms (default 5000)
 */
export function createRevokeAllArmer({ now = Date.now, ms = 5000 } = {}) {
  let armedAt = 0;

  function armed() {
    return armedAt > 0;
  }

  function arm() {
    if (armedAt > 0) return; // already armed: idempotent
    armedAt = now();
  }

  function disarm() {
    armedAt = 0;
  }

  /** Confirm only when armed and inside the window; disarms on success. */
  function confirm() {
    if (armedAt === 0 || now() - armedAt > ms) {
      disarm();
      return false;
    }
    armedAt = 0;
    return true;
  }

  return { armed, arm, disarm, confirm };
}
