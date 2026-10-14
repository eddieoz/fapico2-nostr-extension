// US-1725 — the handler hook: exactly one settle per consented device op.
// The consent gate returns a settle hook only when it opened a prompt window;
// the handler calls it once, after the device op — `ok` on success, the typed
// error sentence on a typed device error (SwError / absence / queue-full). A
// persisted grant (no window) gets no hook and notifies nothing. The hook is
// fire-and-forget: its failure never corrupts the device op's own result, and
// it settles exactly once even if called more than once.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createHandlers } from '../src/worker/handlers.js';
import { makeSettleNotifier } from '../src/worker/consent.js';
import { SW } from '../src/core/ctaphid.js';
import { SwError } from '../src/core/seams.js';

// A device that answers a single frame — enough for get_public_key's one
// GET_PUBKEY command (sw must be OK and data >= 32 bytes).
const device = (sw, data = new Uint8Array(32)) => ({
  run: async () => ({ sw, data }),
});

// A mock consent: prompt-window returns a recording hook; persisted-grant
// returns no hook at all.
function withConsent(notifySettle) {
  return async () => (notifySettle ? { notifySettle } : {});
}

test('US-1725 a prompt-window approval reports the device outcome "ok" once', async () => {
  const settles = [];
  const handlers = createHandlers({
    device: device(SW.OK),
    consent: withConsent((outcome, message) => settles.push({ outcome, message })),
    getActiveSlot: async () => 0,
  });
  await handlers.get_public_key([], { trusted: false, requestId: 'r1', sender: {} });
  assert.deepEqual(settles, [{ outcome: 'ok', message: undefined }]);
});

test('US-1734 a status-word error settles the TYPED sentence, never the raw word (board-run finding)', async () => {
  const settles = [];
  const handlers = createHandlers({
    device: device(0x6985, new Uint8Array(0)),
    consent: withConsent((outcome, message) => settles.push({ outcome, message })),
    getActiveSlot: async () => 0,
  });
  await assert.rejects(
    () => handlers.get_public_key([], { trusted: false, requestId: 'r1', sender: {} }),
    (err) => {
      assert.equal(err.name, 'SwError');
      // US-1734 board run: the raw SwError word ("GET_PUBKEY refused with
      // 0x6985") reached the prompt window verbatim. The settle must carry
      // the error-map sentence — the same words every surface shows.
      assert.deepEqual(settles, [{ outcome: 'err', message: 'touch timed out — the device asked for a touch and none came' }]);
      assert.notEqual(settles[0].message, err.message, 'the raw word never crosses');
      return true;
    },
  );
});

test('US-1725 a persisted grant (no prompt window) notifies nothing', async () => {
  const handlers = createHandlers({
    device: device(SW.OK),
    consent: withConsent(null), // no hook — the handler has nothing to call
    getActiveSlot: async () => 0,
  });
  await handlers.get_public_key([], { trusted: false, requestId: 'r1', sender: {} });
});

test('US-1725 the settle hook fires exactly once even if the handler calls it twice', () => {
  const calls = [];
  const notify = makeSettleNotifier({ settle: (id, outcome, message) => calls.push({ id, outcome, message }) }, 'r1');
  notify('ok');
  notify('ok');
  notify('err', 'boom');
  assert.deepEqual(calls, [{ id: 'r1', outcome: 'ok', message: undefined }]);
});

test('US-1725 the settle hook is inert for a null requestId', () => {
  const calls = [];
  const notify = makeSettleNotifier({ settle: (id) => calls.push(id) }, null);
  assert.doesNotThrow(() => notify('ok'));
  assert.deepEqual(calls, []);
});

test('US-1725 the settle hook swallows a synchronous settle throw (fire-and-forget)', () => {
  const notify = makeSettleNotifier({ settle: () => { throw new Error('sync boom'); } }, 'r1');
  assert.doesNotThrow(() => notify('ok'));
});

test('US-1725 the settle hook swallows an async settle rejection (fire-and-forget)', async () => {
  const notify = makeSettleNotifier({ settle: async () => { throw new Error('async boom'); } }, 'r1');
  assert.doesNotThrow(() => notify('ok'));
  // The rejected promise is handled internally; let the microtask drain.
  await Promise.resolve();
});

test('US-1725 a settle failure in the integration path does not corrupt the device result', async () => {
  // The hook consent actually provides is a makeSettleNotifier — here its
  // prompt.settle rejects, and that rejection must stay swallowed.
  const prompt = { settle: async () => { throw new Error('settle boom'); } };
  const handlers = createHandlers({
    device: device(SW.OK),
    consent: async () => ({ notifySettle: makeSettleNotifier(prompt, 'r1') }),
    getActiveSlot: async () => 0,
  });
  const res = await handlers.get_public_key([], { trusted: false, requestId: 'r1', sender: {} });
  assert.equal(typeof res, 'string');
  assert.equal(res.length, 64); // hex of 32 bytes — the device result stands
});

// US-1734 board run — the port boundary too: a SwError serialized across a
// port carries the typed sentence, not "CMD refused with 0x6985" (the web
// app's NIP-07 rejection showed the raw word on hardware).
test('US-1734 a SwError crossing the port boundary is serialized with its typed sentence', async () => {
  const { serializeError } = await import('../src/worker/errors.js');
  const { SwError } = await import('../src/core/seams.js');
  const err = new SwError('SIGN', 0x6985);
  const wire = serializeError(err);
  assert.equal(wire.message, 'touch timed out — the device asked for a touch and none came');
  assert.equal(wire.sw, 0x6985, 'the status word still rides for machines');
  assert.equal(wire.name, 'SwError');
});
