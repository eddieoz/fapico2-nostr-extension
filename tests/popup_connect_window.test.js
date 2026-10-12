// US-1702 addendum — the connect window. Chromium cancels a WebHID chooser
// anchored to the action popup (the dialog steals focus, the popup closes on
// blur, the request dies), so the chooser runs in a dedicated extension
// window. These tests pin the window flow's contract: the vendor filter,
// pair_device adoption, self-dismissal on success, and a dismissed chooser
// being a retryable refusal rather than a dead end.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnectFlow, connectStateLabel } from '../src/popup/connect.js';

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

// --- US-1713 — the connect page's named states (connectStateLabel) ------------

test('connect window: each health state maps to its named label (US-1713)', async () => {
  // connected — the board granted access.
  {
    const { flow } = rig();
    const h = await flow.connect();
    assert.deepEqual(connectStateLabel(h.state, h.message), {
      line: 'fapico2 board connected', dot: 'connected', lineClass: 'connect-state connected',
    });
  }
  // busy — the worker's 1 s probe window (amber), probed via health.
  {
    const flow = createConnectFlow({
      requestDevice: async () => [],
      busyRetryMs: 5,
      call: async (method) => {
        if (method === 'device_status') return { state: 'busy', code: 'RATE_LIMITED' };
        throw new Error(`unexpected method ${method}`);
      },
    });
    const h = await flow.health({ force: true });
    assert.deepEqual(connectStateLabel(h.state, h.message), {
      line: 'busy — retrying in a second', dot: 'busy', lineClass: 'connect-state waiting',
    });
  }
  // absent — the chooser came up empty (a dismissed refusal): the honest line.
  {
    const { flow } = rig({ requestDeviceImpl: async () => [] });
    const h = await flow.connect();
    assert.equal(h.state, 'absent');
    assert.deepEqual(connectStateLabel(h.state, h.message), {
      line: 'no board granted yet', dot: 'absent', lineClass: 'connect-state',
    });
  }
  // error — a granted-but-failing board: the device-error line, not the absent one.
  {
    const { flow } = rig({ pairResult: { state: 'error', message: 'device error' } });
    const h = await flow.connect();
    assert.equal(h.state, 'error');
    assert.equal(h.message, 'device error');
    assert.deepEqual(connectStateLabel(h.state, h.message), {
      line: 'device error — device error', dot: 'error', lineClass: 'connect-state error',
    });
  }
});

test('connect window: idle and absent share the honest line; error is distinct (US-1713)', () => {
  const idle = connectStateLabel('idle');
  const absent = connectStateLabel('absent');
  // The pre-boot placeholder reads the same honest line as an absent board.
  assert.deepEqual(idle, absent);
  assert.equal(idle.line, 'no board granted yet');
  assert.equal(idle.lineClass, 'connect-state');
  // error is a different state entirely — different line, different class.
  const err = connectStateLabel('error', 'device error');
  assert.notEqual(err.line, absent.line);
  assert.equal(err.line, 'device error — device error');
  assert.equal(err.lineClass, 'connect-state error');
  assert.notEqual(err.lineClass, absent.lineClass);
});
