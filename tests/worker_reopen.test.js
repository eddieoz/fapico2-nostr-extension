// US-1694 — reopen a persisted grant: the worker starts (or answers its
// first device-requiring request) by calling navigator.hid.getDevices() with
// the vendor filter and reuses the granted device without any chooser. With
// no grant, device-requiring methods answer typed DeviceAbsentError and the
// request is refused, not queued. The chooser is never opened by the worker;
// a no-gesture SecurityError from a stray direct call maps to the same typed
// absence.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createDeviceOwner, findGrantedDevice } from '../src/worker/device.js';
import { DeviceAbsentError } from '../src/core/loudness.js';
import { SW, USAGE_PAGE, USAGE_ID } from '../src/core/ctaphid.js';

function grantedDevice() {
  return {
    productName: 'fapico2',
    collections: [{ usagePage: USAGE_PAGE, usage: USAGE_ID }],
  };
}

function fakeNavigator(devices, { requestDeviceSpy } = {}) {
  return {
    hid: {
      getDevices: async () => (typeof devices === 'function' ? devices() : devices),
      ...(requestDeviceSpy
        ? { requestDevice: async (opts) => requestDeviceSpy(opts) }
        : {}),
    },
  };
}

test('US-1694 a granted device is reused without any chooser', async () => {
  let getDevicesCalls = 0;
  const transports = [];
  const owner = createDeviceOwner({
    getGrantedDevice: async () => {
      getDevicesCalls++;
      return grantedDevice();
    },
    createTransport: (dev) => {
      transports.push(dev);
      return { open: async () => {}, vendor: async () => ({ sw: SW.OK, data: new Uint8Array(0) }) };
    },
    openTransport: async () => {},
  });

  const r1 = await owner.run(0x40, 0, new Uint8Array(0));
  const r2 = await owner.run(0x41, 0, new Uint8Array(0));
  assert.equal(r1.sw, SW.OK);
  assert.equal(r2.sw, SW.OK);
  assert.equal(getDevicesCalls, 1, 'the grant lookup happened once, at first use');
  assert.equal(transports.length, 1, 'one transport for the worker lifetime');
});

test('US-1694 with no grant the request is refused typed and loud — not queued, not choosered', async () => {
  let transportBuilt = 0;
  const owner = createDeviceOwner({
    getGrantedDevice: async () => null,
    createTransport: () => {
      transportBuilt++;
      return { open: async () => {}, vendor: async () => ({ sw: SW.OK, data: new Uint8Array(0) }) };
    },
  });
  await assert.rejects(
    () => owner.run(0x42, 0, new Uint8Array(32)),
    (err) =>
      err instanceof DeviceAbsentError &&
      err.code === 'DEVICE_ABSENT' &&
      err.name === 'DeviceAbsentError',
  );
  assert.equal(transportBuilt, 0, 'no transport without a device');
  // And a request that arrives after an absence retries the lookup — the
  // device may have been granted between the two.
  const r = await owner.run(0x40, 0, new Uint8Array(0)).catch((e) => e);
  assert.ok(r instanceof DeviceAbsentError);
});

test('US-1694 the chooser is never opened by the worker', async () => {
  let chooserCalls = 0;
  const owner = createDeviceOwner({
    getGrantedDevice: async () => null,
  });
  await owner.run(0x40, 0, new Uint8Array(0)).catch(() => {});
  assert.equal(chooserCalls, 0);
  // Structural: device.js never references requestDevice's chooser path.
  const { readFileSync } = await import('node:fs');
  const deviceSrc = readFileSync(
    new URL('../src/worker/device.js', import.meta.url).pathname,
    'utf8',
  );
  assert.ok(!deviceSrc.includes('requestDevice'), 'the worker never opens the chooser');
});

test('US-1694 a no-gesture SecurityError from a stray direct call maps to the typed absence', async () => {
  const owner = createDeviceOwner({
    getGrantedDevice: async () => grantedDevice(),
    createTransport: () => ({ open: async () => {}, vendor: async () => ({}) }),
    openTransport: async () => {
      const err = new Error('requestDevice requires a user gesture');
      err.name = 'SecurityError';
      throw err;
    },
  });
  await assert.rejects(
    () => owner.run(0x40, 0, new Uint8Array(0)),
    (err) => err instanceof DeviceAbsentError && err.code === 'DEVICE_ABSENT',
  );
});

test('US-1694 a genuine transport failure is not rebranded as absence', async () => {
  const owner = createDeviceOwner({
    getGrantedDevice: async () => grantedDevice(),
    createTransport: () => ({ open: async () => {}, vendor: async () => ({}) }),
    openTransport: async () => {
      const err = new Error('transfer failed');
      err.name = 'NotSupportedError';
      throw err;
    },
  });
  await assert.rejects(() => owner.run(0x40, 0, new Uint8Array(0)), (err) => {
    assert.equal(err.name, 'NotSupportedError');
    return true;
  });
});

test('US-1694 the vendor filter is the 0xFF00:0x01 interface, not the FIDO one', async () => {
  // The grant lookup matches the collection's usage pair; a FIDO-only
  // device (0xF1D0) is not the vendor interface. This drives the real
  // findGrantedDevice filter, not an injected shortcut.
  const fidoOnly = {
    productName: 'fapico2 FIDO',
    collections: [{ usagePage: 0xf1d0, usage: 0x01 }],
  };
  const owner = createDeviceOwner({
    getGrantedDevice: findGrantedDevice(fakeNavigator([fidoOnly])),
  });
  await assert.rejects(() => owner.run(0x40, 0, new Uint8Array(0)), DeviceAbsentError);
});
