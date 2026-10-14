// US-1715 — the popup boot home-screen decision, extracted pure so the four
// states are testable without the DOM. Given the resolved device health,
// exactly one home is chosen:
//   absent  → connect-first home (US-1716)
//   error   → device-error card  (US-1717)
//   busy    → the normal keys home
//   connected → the normal keys home
// busy is the probe window, not absence, so it never routes to connect-first.
export function homeScreenFor(lastHealth) {
  switch (lastHealth?.state) {
    case 'absent':
      return 'connect-first';
    case 'error':
      return 'device-error';
    case 'busy':
    case 'connected':
    default:
      return 'keys';
  }
}

// US-1716 — the home actions' enabled state and their stated reason. When the
// board is absent, Generate and Import are disabled with one shared clause
// ("needs the board connected"); the empty-keys line says the same thing, so
// there is no three-copy contradiction. `on` means the action is enabled.
export function homeActions(deviceConnected) {
  if (deviceConnected) return { generate: 'on', import: 'on', reason: null };
  return { generate: 'disabled', import: 'disabled', reason: 'needs the board connected' };
}

// US-1717 — the always-visible device card's rendering decision, extracted pure
// so each health state is testable without the DOM. The three non-busy states
// each get their own line and dot so a granted-but-failing board is never
// rendered as absent (which would tell a granted user to "connect it" in a
// loop). `tryAgain` is true only for the error state, where the card offers a
// forced re-probe instead of the absent "connect it" action.
export function deviceCardModel(health) {
  switch (health?.state) {
    case 'connected':
      return { dot: 'connected', line: 'fapico2 board <b>connected</b>', tryAgain: false };
    case 'absent':
      return { dot: 'absent', line: 'no fapico2 board granted — connect it', tryAgain: false };
    case 'error':
      return { dot: 'error', line: 'device error — try again', tryAgain: true };
    case 'busy':
      return { dot: 'busy', line: 'busy — retrying in a second', tryAgain: false };
    default:
      return { dot: 'checking', line: 'checking…', tryAgain: false };
  }
}

// US-1717 — the Try again action. It re-runs the health check with force:true
// so a transient transport failure is re-probed rather than treated as gone.
// The probe is injected so the single-forced-probe behaviour is testable.
export async function tryAgain(probe) {
  return probe({ force: true });
}
