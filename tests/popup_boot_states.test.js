// US-1715 — the popup boot home-screen decision. After the boot chain
// (persisted card → healthCheck → loadKeys → loadActive) resolves state.lastHealth,
// exactly one home is chosen. This pins that mapping: absent → connect-first,
// error → device-error, busy/connected → the normal keys home, and busy never
// routes to connect-first (it is the probe window, not absence).
import test from 'node:test';
import assert from 'node:assert/strict';
import { homeScreenFor } from '../src/popup/home-state.js';

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
