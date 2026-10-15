// US-1716/US-1717 — the ceremony flow: the consent state machine, the
// disclosure order, the elapsed timer against the stated bound, the
// serialization gate, every new status word's sentence, and the stepped
// recovery ladder.

import test from 'node:test';
import assert from 'node:assert/strict';

import { NOSTR_CMD, SW } from '../src/core/ctaphid.js';
import {
  CAP_CEREMONY,
  FLAG_MIGRATION_PENDING,
  CEREMONY_BOUND_SECONDS,
  THREAT_SENTENCE,
  disclosureLines,
  parseMigrationState,
  createCeremonyFlow,
} from '../src/worker/ceremony_flow.js';
import {
  describeSw,
  describeCeremonySw,
  RECOVERY_LADDER,
  CEREMONY_INTERRUPTED_SENTENCE,
} from '../src/worker/error-map.js';
import { createHandlers } from '../src/worker/handlers.js';
import { createDeviceOwner } from '../src/worker/device.js';
import { MockDevice, hexToBytes, bytesToHex } from './mock_device.js';

function rig() {
  const mock = new MockDevice();
  const device = createDeviceOwner({
    getGrantedDevice: async () => ({}),
    createTransport: () => mock,
    openTransport: async () => {},
  });
  const handlers = createHandlers({ device });
  return { mock, device, handlers };
}

const call = async (handlers, method, args) =>
  handlers[method](args, { sender: { url: 'chrome-extension://x/popup.html' }, trusted: true, requestId: 't' });

// A pending board: the ceremony capability advertised, the PIN set, the
// migration bit standing.
const PENDING = { caps: 0x000f, flags: 0x01 | FLAG_MIGRATION_PENDING };
const SEALED = { caps: 0x000f, flags: 0x01 }; // PIN set, marker stands
const OLD_FW = { caps: 0x0003, flags: 0x00 }; // v0.2.0 — no ceremony exists

// --- the connect-time verdict and the state machine -------------------------

test('US-1716 the offer fires exactly on supported AND pending', () => {
  assert.deepEqual(parseMigrationState(PENDING), { supported: true, pending: true, offered: true });
  assert.equal(parseMigrationState(SEALED).offered, false, 'the marker stands — nothing to do');
  assert.equal(parseMigrationState(OLD_FW).offered, false, 'old firmware has no ceremony');
  // Pending implies PIN set by construction (the firmware derives bit2
  // from pin_set), so the flow never offers to a PIN-less board.
  assert.equal(createCeremonyFlow().connect(PENDING).ui, 'offer');
  assert.equal(createCeremonyFlow().connect(SEALED).ui, 'idle');
  assert.equal(createCeremonyFlow().connect(OLD_FW).ui, 'idle');
});

test('US-1716 re-offered at EVERY connect; "Not now" records a dismissal, not a decision', () => {
  const flow = createCeremonyFlow();
  flow.connect(PENDING);
  assert.equal(flow.offerDismissed().ui, 'deferred');
  assert.match(flow.view.notice, /still readable by the old firmware/);
  assert.equal(flow.view.ui, 'deferred');
  // The next connect re-offers — the banner did not buy a permanent no.
  flow.connect(PENDING);
  assert.equal(flow.view.ui, 'offer');
});

test('US-1716 "Not now" sends nothing irreversible and resumes a gated op untouched', async () => {
  const { handlers, mock } = rig();
  const flow = createCeremonyFlow();
  flow.connect(PENDING, { method: 'sign_event', args: [{}] });
  flow.offerDismissed();
  assert.equal(flow.view.resume.method, 'sign_event', 'the gated op rides the dismissal');
  assert.equal(
    mock.calls.filter((c) => c.cmd === NOSTR_CMD.CEREMONY_START).length,
    0,
    'the dismissal sent zero ceremony frames',
  );
});

test('US-1716 accept → running with the timer against the stated bound → complete → ready + resume', () => {
  let t = 1_000;
  const flow = createCeremonyFlow({ now: () => t });
  flow.connect(PENDING, { method: 'sign_event', args: [] });
  assert.equal(flow.offerAccepted().ui, 'running');
  assert.equal(flow.view.bound, CEREMONY_BOUND_SECONDS);
  assert.equal(flow.elapsedSeconds(), 0);
  t += 5_000;
  assert.equal(flow.tick().elapsed, 5, 'the tick carries fresh whole seconds');
  // Past the bound it keeps counting — information, not an error.
  t += CEREMONY_BOUND_SECONDS * 1000 + 2_000;
  assert.equal(flow.tick().elapsed, CEREMONY_BOUND_SECONDS + 7);
  assert.equal(flow.elapsedSeconds(), CEREMONY_BOUND_SECONDS + 7);
  // 9000 with the migrated(2 BE) ‖ already(2 BE) body: the gated op resumes.
  const done = flow.ceremonyOk(new Uint8Array([0x00, 0x03, 0x00, 0x01]));
  assert.equal(done.ui, 'ready');
  assert.equal(done.migrated, 3);
  assert.equal(done.already, 1);
  assert.deepEqual(done.resume, { method: 'sign_event', args: [] });
  assert.equal(flow.pending, null);
});

test('US-1716 0x6F02 — the device says nothing to do: the flow stands down and resumes', () => {
  const flow = createCeremonyFlow();
  flow.connect(PENDING, { method: 'sign_event', args: [] });
  flow.offerAccepted();
  const v = flow.ceremonyNotNeeded();
  assert.equal(v.ui, 'ready');
  assert.equal(v.needed, false);
  assert.deepEqual(v.resume, { method: 'sign_event', args: [] });
});

test('US-1716 interrupted → retryable, through THIS dialog at connect — never in a sign op', () => {
  const flow = createCeremonyFlow();
  flow.connect(PENDING);
  flow.offerAccepted();
  const v = flow.ceremonyInterrupted();
  assert.equal(v.ui, 'interrupted');
  assert.equal(v.interrupted, true);
  assert.deepEqual(v.ladder, RECOVERY_LADDER);
  // The next connect re-offers the consent dialog — the retry offer.
  flow.connect(PENDING);
  assert.equal(flow.view.ui, 'offer');
});

test('US-1716 sealed-unavailable → the stepped ladder view', () => {
  const flow = createCeremonyFlow();
  const v = flow.sealedUnavailable();
  assert.equal(v.ui, 'sealed');
  assert.deepEqual(v.ladder, RECOVERY_LADDER);
});

// --- the dialog disclosure order --------------------------------------------

test('US-1716 the disclosure is in the fixed order: what → irreversible → bound → plugged-in → PIN consequence → threat sentence last', () => {
  const lines = disclosureLines();
  assert.equal(lines.length, 5);
  assert.match(lines[0], /seals every identity/);
  assert.match(lines[0], /one-time, permanent protection against old-firmware extraction/);
  assert.match(lines[1], /irreversible/);
  assert.match(lines[2], new RegExp(`at most ${CEREMONY_BOUND_SECONDS} seconds`));
  assert.match(lines[2], /leave the board plugged in; the button is not needed/);
  assert.match(lines[3], /generated identities are unrecoverable/);
  assert.match(lines[3], /imported identities come back from your backup file/);
  assert.equal(lines[4], THREAT_SENTENCE, 'the threat-model ceilings ride as the one sentence, last');
});

test('US-1716 the bound is an upper bound, not a measurement — named for the hardware session', () => {
  // The constant is honest about its provenance in its comment; the test
  // pins that the dialog PRINTS it as a bound ("at most"), never as a
  // measured duration.
  assert.equal(typeof CEREMONY_BOUND_SECONDS, 'number');
  assert.ok(CEREMONY_BOUND_SECONDS > 0);
  assert.match(disclosureLines()[2], /at most/);
});

// --- the handler, the mock as emulator, and the serialization gate ----------

test('US-1716 ceremony_start rides 0x4E and returns the applet counts from the 4-byte body', async () => {
  const { handlers, mock } = rig();
  mock.pin = '731742';
  mock.ceremonyPending = true;
  mock.info.caps = 0x000f;
  const r = await call(handlers, 'ceremony_start', []);
  assert.equal(r.migrated, mock.keys.length);
  assert.equal(r.already, 1, 'the PIN record is counted separately');
  assert.equal(mock.calls.at(-1).cmd, NOSTR_CMD.CEREMONY_START);
  assert.equal(mock.calls.at(-1).cmd, 0x4e);
  assert.equal(mock.ceremonyPending, false, 'the mock models the marker landing');
  // A second start answers 6F02 — nothing to do.
  await assert.rejects(() => call(handlers, 'ceremony_start', []), (err) => err.sw === SW.CEREMONY_NOT_NEEDED);
});

test('US-1716 a 0x6F00 mid-ceremony is typed CeremonyInterruptedError — never store-fault phrasing', async () => {
  let answer = { sw: 0x6f00, data: new Uint8Array(0) };
  const device = createDeviceOwner({
    getGrantedDevice: async () => ({}),
    createTransport: () => ({ vendor: async () => answer }),
    openTransport: async () => {},
  });
  const handlers = createHandlers({ device });
  await assert.rejects(
    () => call(handlers, 'ceremony_start', []),
    (err) =>
      err.name === 'CeremonyInterruptedError' &&
      err.message === CEREMONY_INTERRUPTED_SENTENCE &&
      !/store fault/i.test(err.message),
  );
  answer = { sw: SW.CEREMONY_NOT_NEEDED, data: new Uint8Array(0) };
  await assert.rejects(() => call(handlers, 'ceremony_start', []), (err) => err.name === 'SwError');
});

test('US-1716 the serialization gate: no second vendor frame mid-ceremony; queued ops settle after', async () => {
  const calls = [];
  const gates = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const transport = {
    vendor(cmd) {
      assert.ok(inFlight === 0, 'the firmware must never see an overlapping vendor request');
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      calls.push(cmd);
      return new Promise((resolve) => {
        gates.push((result) => {
          inFlight--;
          resolve(result);
        });
      });
    },
  };
  const device = createDeviceOwner({
    getGrantedDevice: async () => ({}),
    createTransport: () => transport,
    openTransport: async () => {},
  });
  const handlers = createHandlers({ device });
  const ceremony = call(handlers, 'ceremony_start', []);
  const sign = call(handlers, 'list_keys', []);
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(calls, [NOSTR_CMD.CEREMONY_START], 'only the ceremony is on the wire');
  gates[0]({ sw: SW.OK, data: new Uint8Array([0x00, 0x02, 0x00, 0x00]) });
  const r = await ceremony;
  assert.deepEqual(r, { migrated: 2, already: 0 });
  gates[1]({ sw: SW.OK, data: new Uint8Array(96) });
  await sign;
  assert.deepEqual(calls, [NOSTR_CMD.CEREMONY_START, NOSTR_CMD.LIST_KEYS], 'the queued op settled strictly after');
  assert.equal(maxInFlight, 1);
});

// --- every new status word resolves to a sentence; the ladder's step order --

test('US-1717 every new status word resolves to a sentence', () => {
  for (const sw of [0x6f01, 0x6f02]) {
    const d = describeSw(sw);
    assert.equal(d.known, true, `0x${sw.toString(16)} must be translated before ship`);
    assert.ok(d.message.length > 20);
  }
  const sealed = describeSw(0x6f01);
  assert.equal(sealed.code, 'SW_SEALED_UNAVAILABLE');
  assert.deepEqual(sealed.ladder, RECOVERY_LADDER, 'the sealed sentence carries the stepped ladder');
  assert.equal(describeSw(0x6f02).code, 'SW_CEREMONY_NOT_NEEDED');
});

test('US-1717 interrupted never maps to the store-fault sentence', () => {
  const d = describeCeremonySw(0x6f00);
  assert.equal(d.code, 'SW_CEREMONY_INTERRUPTED');
  assert.ok(!/store fault/i.test(d.message), '"its store faulted" promises a hardware failure that did not happen');
  assert.match(d.message, /running it again completes it/);
  // Outside the ceremony context the generic map still names the fault.
  assert.equal(describeSw(0x6f00).code, 'SW_STORE_FAULT');
});

test('US-1717 the recovery ladder is stepped and RESET is never co-equal', () => {
  assert.deepEqual(
    RECOVERY_LADDER.map((s) => s.step),
    [1, 2, 3],
  );
  assert.match(RECOVERY_LADDER[0].body, /5 seconds/);
  assert.match(RECOVERY_LADDER[1].body, /BOOTSEL/);
  assert.match(RECOVERY_LADDER[1].body, /does not touch the identities/);
  const reset = RECOVERY_LADDER[2];
  assert.match(reset.title, /last resort/);
  assert.match(reset.body, /imported identities come back from your backup file/);
  assert.match(reset.body, /generated identities are gone permanently/);
});

