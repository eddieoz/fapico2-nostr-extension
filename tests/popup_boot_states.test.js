// US-1715 — the popup boot home-screen decision. After the boot chain
// (persisted card → healthCheck → loadKeys → loadActive) resolves state.lastHealth,
// exactly one home is chosen. This pins that mapping: absent → connect-first,
// error → device-error, busy/connected → the normal keys home, and busy never
// routes to connect-first (it is the probe window, not absence).
import test from 'node:test';
import assert from 'node:assert/strict';
import { homeScreenFor, homeActions, deviceCardModel, tryAgain } from '../src/popup/home-state.js';

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

// US-1717 — the device card renders the three non-busy states distinctly. A
// granted-but-failing board says "device error — try again" with a Try again
// action and its own dot; it is never rendered as the absent "connect it".
test('US-1717 an error state renders the error card with a Try again action', () => {
  const m = deviceCardModel({ state: 'error', message: 'open failure' });
  assert.equal(m.dot, 'error');
  assert.equal(m.line, 'device error — try again');
  assert.equal(m.tryAgain, true);
});

test('US-1717 an absent board never renders the error line or a Try again', () => {
  const m = deviceCardModel({ state: 'absent' });
  assert.notEqual(m.dot, 'error');
  assert.doesNotMatch(m.line, /device error/i);
  assert.equal(m.tryAgain, false);
});

test('US-1717 connected and busy never offer a Try again', () => {
  assert.equal(deviceCardModel({ state: 'connected' }).tryAgain, false);
  assert.equal(deviceCardModel({ state: 'busy' }).tryAgain, false);
});

test('US-1717 Try again re-issues exactly one forced probe', async () => {
  let calls = 0;
  const seen = [];
  const probe = async (opts) => {
    calls += 1;
    seen.push(opts);
    return { state: 'connected' };
  };
  const result = await tryAgain(probe);
  assert.equal(calls, 1);
  assert.deepEqual(seen, [{ force: true }]);
  assert.deepEqual(result, { state: 'connected' });
});
