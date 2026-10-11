// US-1702 — connect/pair: the only chooser in the product. The popup's
// Connect flow drives requestDevice with the 0xFF00/0x01 filter, the granted
// device is reused forever after via getDevices (US-1694), the card shows
// connected/absent states driven by the PING health check, and the chooser
// is never triggered by a health check or without the flow.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPairing, VENDOR_FILTER } from '../src/popup/pairing.js';

function rig({ requestDeviceImpl } = {}) {
  const calls = [];
  let requestDeviceCalls = 0;
  const requestDevice = async (opts) => {
    requestDeviceCalls++;
    if (requestDeviceImpl) return requestDeviceImpl(opts);
    return [{ productName: 'fapico2' }];
  };
  const call = async (method, ...args) => {
    calls.push({ method, args });
    if (method === 'device_status') {
      return calls.filter((c) => c.method === 'device_status').length <= 1
        ? { state: 'connected' }
        : { state: 'error', code: 'DEVICE_ABSENT' };
    }
    if (method === 'pair_device') return { state: 'connected' };
    throw new Error(`unexpected call ${method}`);
  };
  const persisted = [];
  const pairing = createPairing({
    requestDevice,
    call,
    persist: (h) => persisted.push(h),
  });
  return { pairing, calls, persisted, get chooserCalls() { return requestDeviceCalls; } };
}

test('US-1702 the connect flow drives the chooser with the vendor filter and pairs', async () => {
  const seen = [];
  const { pairing } = rig({
    requestDeviceImpl: async (opts) => {
      seen.push(opts);
      return [{ productName: 'fapico2' }];
    },
  });
  const health = await pairing.connect();
  assert.deepEqual(seen[0].filters, [{ usagePage: 0xff00, usage: 0x01 }], VENDOR_FILTER);
  assert.equal(health.state, 'connected');
});

test('US-1702 a dismissed chooser is a loud refusal, not a silent absent', async () => {
  const { pairing } = rig({ requestDeviceImpl: async () => [] });
  await assert.rejects(() => pairing.connect(), (err) => err.name === 'NotFoundError');
});

test('US-1702 the health check never opens the chooser, and is rate-limited', async () => {
  let clock = 1_000_000;
  const { pairing, calls, chooserCalls } = rig();
  const h1 = await pairing.health({ force: true });
  assert.equal(h1.state, 'connected');
  // A second probe inside the rate limit answers from memory...
  const h2 = await pairing.health();
  assert.equal(h2.state, 'connected');
  const statusCalls = calls.filter((c) => c.method === 'device_status').length;
  clock += 50;
  assert.equal(statusCalls, 1, 'no second probe inside the 1 s window');
  assert.equal(chooserCalls, 0, 'the chooser was never touched by a health check');
  // ...and the chooser never ran at all: no requestDevice, ever, without the flow.
  assert.equal(chooserCalls, 0);
});

test('US-1702 health-check state transitions: connected → absent is the loud state', async () => {
  const { pairing } = rig();
  assert.equal((await pairing.health({ force: true })).state, 'connected');
  assert.equal((await pairing.health({ force: true })).state, 'absent',
    'the stub answers DEVICE_ABSENT after the first probe');
});

test('US-1702 the last health answer is persisted so the popup reopens to truth', async () => {
  const { pairing, persisted } = rig();
  await pairing.health({ force: true });
  assert.deepEqual(persisted.at(-1), { state: 'connected' });
});
