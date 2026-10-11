// US-1671 — the loud signer (design D10, §3.2): no silent fallback, no
// buffered signing, device-absent is a typed, non-dismissible, loud state
// that names the device.

import test from 'node:test';
import assert from 'node:assert/strict';

import { verifyEvent } from 'nostr-tools';

import {
  DeviceAbsentError,
  SignerKinds,
  createSignerIndicator,
  createSignerSource,
  mapDeviceError,
} from '../src/core/loudness.js';
import { CtapError, CtapErr } from '../src/core/ctaphid.js';
import { createNostrBridge, installPageNostr } from '../src/core/window_nostr.js';
import { FapicoSigner } from '../src/core/seams.js';
import { MockDevice } from './mock_device.js';

test('US-1671 device absence is typed and names the device', () => {
  // Mid-ceremony unplugging: the transport throws CtapError(DEVICE_ABSENT).
  const mapped = mapDeviceError(
    new CtapError(CtapErr.DEVICE_ABSENT, 'device gone'),
    'Fapico board',
  );
  assert.ok(mapped instanceof DeviceAbsentError);
  assert.equal(mapped.code, 'DEVICE_ABSENT');
  assert.equal(mapped.device, 'Fapico board');
  // Chooser cancelled: the browser rejects with NotFoundError.
  const cancelled = mapDeviceError(new Error('user cancelled'), 'Fapico board');
  assert.ok(!(cancelled instanceof DeviceAbsentError));
  const chooserAbsent = mapDeviceError(
    Object.assign(new Error('No device selected'), { name: 'NotFoundError' }),
    'Fapico board',
  );
  assert.ok(chooserAbsent instanceof DeviceAbsentError);
  // A genuine device error is not rebranded as absence.
  const broken = mapDeviceError(
    new CtapError(CtapErr.DEVICE_ERROR, 'device broken'),
    'Fapico board',
  );
  assert.equal(broken.code, 'DEVICE_ERROR');
});

test('US-1671 a hardware-mode request with no device never falls back to software', async () => {
  let softwareCalls = 0;
  const source = createSignerSource({
    mode: 'hardware',
    hardware: async () => {
      throw new DeviceAbsentError('Fapico board');
    },
    software: async () => {
      softwareCalls += 1;
      throw new Error('software signer must never be reached');
    },
  });
  await assert.rejects(
    () => source.get(),
    (err) => err.code === 'DEVICE_ABSENT',
  );
  assert.equal(softwareCalls, 0, 'the fallback must not exist, not merely be guarded');
});

test('US-1671 an absent-device request is refused, not queued', async () => {
  const win = {
    location: { origin: 'https://page.example' },
    nostr: undefined,
    listeners: [],
    addEventListener(type, fn) {
      if (type === 'message') this.listeners.push(fn);
    },
    postMessage(data) {
      setImmediate(() => this.listeners.forEach((fn) => fn({ source: this, data })));
    },
  };
  const absences = [];
  let deviceRequests = 0;
  const handler = createNostrBridge({
    getSigner: async () => {
      deviceRequests += 1;
      throw new DeviceAbsentError('Fapico board');
    },
    onDeviceAbsent: (device) => absences.push(device),
  });
  // The bridge is stateless between calls: two rapid requests are refused
  // on their own merits — each wakes the signer once, none is queued for
  // when a device might appear.
  const first = handler('signEvent', [{ kind: 1, content: 'a', tags: [], created_at: 1 }]);
  const second = handler('signEvent', [{ kind: 1, content: 'b', tags: [], created_at: 2 }]);
  const r1 = await first;
  const r2 = await second;
  assert.equal(r1.error.code, 'DEVICE_ABSENT');
  assert.equal(r2.error.code, 'DEVICE_ABSENT');
  assert.equal(deviceRequests, 2, 'each request tried the device on its own');
  assert.deepEqual(absences, ['Fapico board', 'Fapico board']);
  assert.equal(win.nostr, undefined, 'the refusal happened without a provider ever buffering work');
});

test('US-1671 the popup indicator reflects which signer produced the last signature', async () => {
  let clock = 1_000;
  const persisted = [];
  const indicator = createSignerIndicator({
    now: () => clock,
    persist: (s) => persisted.push(JSON.parse(JSON.stringify(s))),
  });
  const mock = new MockDevice();
  const handler = createNostrBridge({
    getSigner: async () => new FapicoSigner(mock),
    onSignature: (kind) => indicator.noteSignature(kind),
  });
  const signed = await handler('signEvent', [
    { kind: 1, content: 'hardware', tags: [], created_at: 1 },
  ]);
  assert.ok(verifyEvent(signed.result));
  assert.equal(indicator.snapshot().lastSignature.signer, SignerKinds.HARDWARE);
  assert.equal(indicator.snapshot().lastSignature.at, 1_000);
  clock = 2_000;
  await handler('signEvent', [
    { kind: 1, content: 'again', tags: [], created_at: 3 },
  ]);
  assert.equal(indicator.snapshot().lastSignature.at, 2_000);
  assert.ok(persisted.length >= 2, 'the indicator state persists for the popup');
  // The bridge reports the kind the SIGNER reports, not the kind requested.
  const swIndicator = createSignerIndicator();
  await createNostrBridge({
    getSigner: async () => ({ kind: SignerKinds.SOFTWARE, getPublicKey: async () => 'aa' }),
    onSignature: (kind) => swIndicator.noteSignature(kind),
  })('getPublicKey', []);
  assert.equal(swIndicator.snapshot().lastSignature, null, 'getPublicKey is not a signature');
});

test('US-1671 device-absent is non-dismissible: only a hardware answer clears it', () => {
  let clock = 0;
  const indicator = createSignerIndicator({ now: () => clock });
  indicator.noteDeviceAbsent('Fapico board');
  assert.equal(indicator.snapshot().deviceAbsent.device, 'Fapico board');
  // Time passing does not clear it — there is no timeout and no dismiss.
  clock += 3_600_000;
  assert.ok(indicator.snapshot().deviceAbsent, 'still absent, still loud');
  // A software signature is not the device: it does not clear the state.
  indicator.noteSignature(SignerKinds.SOFTWARE);
  assert.ok(indicator.snapshot().deviceAbsent, 'software must not hush the hardware warning');
  // The device answering again is the only thing that clears it.
  indicator.noteSignature(SignerKinds.HARDWARE);
  assert.equal(indicator.snapshot().deviceAbsent, null);
});

test('US-1671 end to end: the transport absence error drives the indicator through the bridge', async () => {
  const indicator = createSignerIndicator();
  const handler = createNostrBridge({
    getSigner: async () => {
      throw new CtapError(CtapErr.DEVICE_ABSENT, 'device gone mid-call');
    },
    onSignature: (kind) => indicator.noteSignature(kind),
    onDeviceAbsent: (device) => indicator.noteDeviceAbsent(device),
  });
  const reply = await handler('getPublicKey', []);
  assert.equal(reply.error.code, 'DEVICE_ABSENT');
  assert.equal(indicator.snapshot().deviceAbsent.device, 'Fapico board');
  assert.equal(indicator.snapshot().lastSignature, null);
});

test('US-1672 the interrupted-ceremony state is loud until the device answers again', () => {
  let clock = 0;
  const indicator = createSignerIndicator({ now: () => clock });
  indicator.noteCeremonyInterrupted();
  assert.equal(indicator.snapshot().ceremonyInterrupted.at, 0);
  // Time passing does not clear it; software signatures do not either.
  clock += 60_000;
  indicator.noteSignature(SignerKinds.SOFTWARE);
  assert.ok(indicator.snapshot().ceremonyInterrupted, 'still interrupted, still loud');
  indicator.noteSignature(SignerKinds.HARDWARE);
  assert.equal(indicator.snapshot().ceremonyInterrupted, null, 'the device answering clears it');
});
