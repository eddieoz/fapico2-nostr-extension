// US-1693 — device serialization: the second request WAITS on the queue, it
// never reaches the firmware while another transaction is in flight (the
// firmware refuses a second vendor request while a touch window is parked,
// 6985, red-team F6 — the mock's refuse-while-parked mode must never
// trigger). A queued request still RUNS after the first ends in the
// touch-timed-out 6985. Disconnection drops queued entries. No transport
// construction outside src/worker/device.js.

import test from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDeviceOwner, QUEUE_MAX } from '../src/worker/device.js';
import { SW } from '../src/core/ctaphid.js';

const here = dirname(fileURLToPath(import.meta.url));

/** A scripted transport double at the `vendor()` contract: records every
 *  call with its concurrency, and gates each command on a deferred the test
 *  controls. `refuseWhileParked` mirrors hid_serve.rs: a vendor call while
 *  another is in flight is the 6985 refusal the queue must never cause. */
function scriptedTransport({ refuseWhileParked = true } = {}) {
  const calls = [];
  const gates = [];
  let inFlight = 0;
  return {
    calls,
    gates,
    stats: { maxInFlight: 0, refusedWhileParked: 0 },
    vendor(cmd, idx, arg) {
      if (inFlight > 0 && refuseWhileParked) {
        this.stats.refusedWhileParked++;
        return Promise.resolve({ sw: SW.TOUCH_REQUIRED, data: new Uint8Array(0) });
      }
      inFlight++;
      this.stats.maxInFlight = Math.max(this.stats.maxInFlight, inFlight);
      calls.push({ cmd, idx, argLen: arg.length });
      return new Promise((resolve) => {
        gates.push(resolve);
      });
    },
    settle(i, result) {
      inFlight--;
      gates[i](result);
    },
    get settledCount() {
      return gates.length;
    },
  };
}

const SIGN = 0x42;

/** Settle every gate the pump has opened so far, yielding so the pump can
 *  start the next queued job — repeat until nothing is in flight. */
async function settleAll(transport, result) {
  for (let guard = 0; guard < 200; guard++) {
    const n = transport.gates.length;
    if (n === 0) break;
    for (let i = 0; i < n; i++) transport.settle(i, result);
    await new Promise((r) => setTimeout(r, 2));
  }
}

test('US-1693 two concurrent SIGNs produce exactly one SIGN frame until the first resolves', async () => {
  const transport = scriptedTransport();
  const owner = createDeviceOwner({
    getGrantedDevice: async () => ({}),
    createTransport: () => transport,
    openTransport: async () => {},
  });

  const first = owner.run(SIGN, 0, new Uint8Array(32));
  const second = owner.run(SIGN, 0, new Uint8Array(32));
  await Promise.resolve(); // let the pump start the first job
  await new Promise((r) => setTimeout(r, 5));

  assert.equal(transport.calls.length, 1, 'only the first request is on the wire');
  assert.equal(transport.stats.refusedWhileParked, 0, 'the refuse-while-parked path never triggered');
  assert.equal(transport.stats.maxInFlight, 1);

  transport.settle(0, { sw: SW.OK, data: new Uint8Array(96) });
  const firstResult = await first;
  assert.equal(firstResult.sw, SW.OK);
  transport.settle(1, { sw: SW.OK, data: new Uint8Array(96) });
  const secondResult = await second;
  assert.equal(secondResult.sw, SW.OK);
  assert.equal(transport.calls.length, 2, 'the queued request ran after the first settled');
  assert.equal(transport.stats.refusedWhileParked, 0);
});

test('US-1693 a queued request still runs after the first ends in the touch-timed-out 6985', async () => {
  const transport = scriptedTransport();
  const owner = createDeviceOwner({
    getGrantedDevice: async () => ({}),
    createTransport: () => transport,
    openTransport: async () => {},
  });

  const first = owner.run(SIGN, 0, new Uint8Array(32));
  const second = owner.run(SIGN, 0, new Uint8Array(32));
  await new Promise((r) => setTimeout(r, 5));
  transport.settle(0, { sw: SW.TOUCH_REQUIRED, data: new Uint8Array(0) });
  const r1 = await first;
  assert.equal(r1.sw, SW.TOUCH_REQUIRED, 'the 6985 crosses as the result, typed by the seam layer');
  transport.settle(1, { sw: SW.OK, data: new Uint8Array(96) });
  const r2 = await second;
  assert.equal(r2.sw, SW.OK, 'the queued request ran, not failed');
  transport.settle(1, { sw: SW.OK, data: new Uint8Array(96) });
});

test('US-1693 the queue is bounded at 64; overflow is typed device-queue-full', async () => {
  const transport = scriptedTransport();
  const owner = createDeviceOwner({
    getGrantedDevice: async () => ({}),
    createTransport: () => transport,
    openTransport: async () => {},
  });

  const jobs = [];
  // One in flight + 64 queued fills the bounded queue (the in-flight job
  // has left the queue, so the bound counts the waiting entries).
  for (let i = 0; i < QUEUE_MAX + 1; i++) jobs.push(owner.run(SIGN, 0, new Uint8Array(32)));
  await new Promise((r) => setTimeout(r, 5));
  await assert.rejects(
    () => owner.run(SIGN, 0, new Uint8Array(32)),
    (err) => err.code === 'device-queue-full' && err.name === 'QueueFullError',
  );
  await settleAll(transport, { sw: SW.OK, data: new Uint8Array(96) });
  await Promise.allSettled(jobs);
});

test('US-1693 a queued request whose port disconnected is dropped before dispatch', async () => {
  const transport = scriptedTransport();
  const owner = createDeviceOwner({
    getGrantedDevice: async () => ({}),
    createTransport: () => transport,
    openTransport: async () => {},
  });

  const first = owner.run(SIGN, 0, new Uint8Array(32), {}, 'nostr-1');
  const queued = owner.run(SIGN, 0, new Uint8Array(32), {}, 'nostr-1');
  await new Promise((r) => setTimeout(r, 5));

  owner.dropQueued('nostr-1');
  // Only the in-flight job stays; the queued one rejects typed, now.
  await assert.rejects(() => queued, (err) => err.code === 'port-disconnected');
  transport.settle(0, { sw: SW.OK, data: new Uint8Array(96) });
  const r1 = await first;
  assert.equal(r1.sw, SW.OK);
  assert.equal(transport.calls.length, 1, 'the dropped job never reached the device');
  // A differently-tagged queued job would not be dropped.
  const other = owner.run(SIGN, 0, new Uint8Array(32), {}, 'nostr-2');
  await new Promise((r) => setTimeout(r, 5));
  owner.dropQueued('nostr-1');
  transport.settle(1, { sw: SW.OK, data: new Uint8Array(96) });
  const rOther = await other;
  assert.equal(rOther.sw, SW.OK, 'a different port\'s queued job survives');
});

test('US-1693 no transport construction outside src/worker/device.js', () => {
  const offenders = [];
  for (const dir of ['src/worker', 'src/content', 'src/provider', 'src/popup', 'src/prompt']) {
    for (const f of readdirSync(join(here, '..', dir))) {
      if (!f.endsWith('.js')) continue;
      const text = readFileSync(join(here, '..', dir, f), 'utf8');
      if (dir !== 'src/worker' && text.includes('CtapVendorTransport')) {
        offenders.push(`${dir}/${f}`);
      }
    }
  }
  assert.deepEqual(offenders, [], 'only src/worker/device.js may construct transports');
  const deviceSrc = readFileSync(join(here, '..', 'src/worker/device.js'), 'utf8');
  assert.ok(deviceSrc.includes('new CtapVendorTransport'), 'device.js is the constructor site');
});
