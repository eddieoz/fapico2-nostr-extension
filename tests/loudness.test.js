// US-1671 — the loud signer (design D10, §3.2): no silent fallback, no
// buffered signing, device-absent is a typed, non-dismissible, loud state
// that names the device.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DeviceAbsentError,
  SignerKinds,
  createSignerIndicator,
  createSignerSource,
  mapDeviceError,
} from '../src/core/loudness.js';
import { CtapError, CtapErr } from '../src/core/ctaphid.js';

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
