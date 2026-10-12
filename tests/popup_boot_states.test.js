// US-1715 — the popup boot home-screen decision. After the boot chain
// (persisted card → healthCheck → loadKeys → loadActive) resolves state.lastHealth,
// exactly one home is chosen. This pins that mapping: absent → connect-first,
// error → device-error, busy/connected → the normal keys home, and busy never
// routes to connect-first (it is the probe window, not absence).
import test from 'node:test';
import assert from 'node:assert/strict';
import { homeScreenFor, homeActions } from '../src/popup/home-state.js';

test('US-1715 a persisted connected card reopens on the normal keys home (fast path)', () => {
  assert.equal(homeScreenFor({ state: 'connected' }), 'keys');
});

test('US-1715 absent routes to the connect-first home', () => {
  assert.equal(homeScreenFor({ state: 'absent' }), 'connect-first');
});

test('US-1715 error routes to the device-error card', () => {
  assert.equal(homeScreenFor({ state: 'error' }), 'device-error');
});

test('US-1715 busy stays on the normal keys home — it is the probe window, not absence', () => {
  assert.equal(homeScreenFor({ state: 'busy' }), 'keys');
  // and never the connect-first home that absence would take
  assert.notEqual(homeScreenFor({ state: 'busy' }), 'connect-first');
});

test('US-1715 an unknown or missing health defaults to the normal keys home', () => {
  assert.equal(homeScreenFor(null), 'keys');
  assert.equal(homeScreenFor({}), 'keys');
});

// US-1716 — Generate and Import are disabled with one shared reason while the
// board is absent, and enabled once it is connected.
test('US-1716 absent disables Generate and Import with one stated reason', () => {
  const a = homeActions(false);
  assert.equal(a.generate, 'disabled');
  assert.equal(a.import, 'disabled');
  assert.equal(a.reason, 'needs the board connected');
});

test('US-1716 connected enables Generate and Import', () => {
  const a = homeActions(true);
  assert.equal(a.generate, 'on');
  assert.equal(a.import, 'on');
  assert.equal(a.reason, null);
});

test('US-1716 a mid-session connect re-renders to the normal keys home with working actions', () => {
  assert.equal(homeScreenFor({ state: 'connected' }), 'keys');
  assert.equal(homeActions(true).generate, 'on');
});
