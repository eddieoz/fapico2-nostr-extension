// US-1702 addendum — the connect window. Chromium cancels a WebHID chooser
// anchored to the action popup (the dialog steals focus, the popup closes on
// blur, the request dies), so the chooser runs in a dedicated extension
// window. These tests pin the window flow's contract: the vendor filter,
// pair_device adoption, self-dismissal on success, and a dismissed chooser
// being a retryable refusal rather than a dead end.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnectFlow } from '../src/popup/connect.js';

function rig({ requestDeviceImpl, pairResult, autoCloseMs = 5 } = {}) {
  const seen = { chooserCalls: 0, filter: null, pairCalls: 0, closeEvents: 0, persisted: [] };
  const requestDevice = async (opts) => {
    seen.chooserCalls++;
    seen.filter = opts;
    return requestDeviceImpl ? requestDeviceImpl(opts) : [{ vendorId: 0xfa20 }];
  };
  const call = async (method) => {
    if (method === 'pair_device') {
      seen.pairCalls++;
      if (pairResult instanceof Error) throw pairResult;
      return pairResult ?? { state: 'connected', version: '0.1.0' };
    }
    throw new Error(`unexpected method ${method}`);
  };
  const flow = createConnectFlow({
    requestDevice,
    call,
    persist: (h) => seen.persisted.push(h),
    onClose: () => seen.closeEvents++,
    autoCloseMs,
  });
  return { flow, seen };
}

test('connect window: the chooser runs with the vendor filter and pairs on success', async () => {
  const { flow, seen } = rig();
  const health = await flow.connect();
  assert.equal(health.state, 'connected');
  assert.equal(seen.chooserCalls, 1);
  assert.deepEqual(seen.filter, { filters: [{ usagePage: 0xff00, usage: 0x01 }] });
  assert.equal(seen.pairCalls, 1);
  assert.equal(seen.persisted.at(-1).state, 'connected');
});

test('connect window: success dismisses the window after a visible beat', async () => {
  const { flow, seen } = rig({ autoCloseMs: 5 });
  await flow.connect();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(seen.closeEvents, 1);
});

test('connect window: a dismissed chooser is retryable — no close, cancelled state', async () => {
  // The chooser comes up empty once (dismissed), then lists the board.
  const results = [[], [{ vendorId: 0xfa20 }]];
  const { flow, seen } = rig({ requestDeviceImpl: async () => results.shift() ?? [] });
  const health = await flow.connect();
  assert.equal(health.state, 'absent');
  assert.equal(health.cancelled, true);
  assert.equal(seen.closeEvents, 0);
  assert.equal(seen.pairCalls, 0);
  // ...and the same flow can complete on the next click.
  const second = await flow.connect();
  assert.equal(second.state, 'connected');
  await new Promise((r) => setTimeout(r, 30)); // the close is a beat after the green state
  assert.equal(seen.closeEvents, 1);
});

test('connect window: a pairing failure surfaces as an error card, window stays', async () => {
  const { flow, seen } = rig({ pairResult: { state: 'error', message: 'device error' } });
  const health = await flow.connect();
  assert.equal(health.state, 'error');
  assert.equal(health.message, 'device error');
  assert.equal(seen.closeEvents, 0);
});

test('connect window: boot health retries a busy worker once, then reports the live truth', async () => {
  // The popup's own boot probe fires moments before this window opens, so
  // the first probe lands in the worker's 1 s rate window: busy once, then
  // the live answer.
  const statuses = [{ state: 'busy', code: 'RATE_LIMITED' }, { state: 'connected' }];
  let probes = 0;
  const flow = createConnectFlow({
    requestDevice: async () => [],
    busyRetryMs: 5,
    call: async (method) => {
      if (method === 'device_status') {
        probes++;
        return statuses.shift() ?? { state: 'connected' };
      }
      throw new Error(`unexpected method ${method}`);
    },
  });
  const h = await flow.health({ force: true });
  assert.equal(h.state, 'connected');
  assert.equal(probes, 2);
});

test('connect window: a worker busy on both probes stays busy — amber, never an error', async () => {
  const flow = createConnectFlow({
    requestDevice: async () => [],
    busyRetryMs: 5,
    call: async (method) => {
      if (method === 'device_status') return { state: 'busy', code: 'RATE_LIMITED' };
      throw new Error(`unexpected method ${method}`);
    },
  });
  const h = await flow.health({ force: true });
  assert.equal(h.state, 'busy');
});
