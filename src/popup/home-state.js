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
