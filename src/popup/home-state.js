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
