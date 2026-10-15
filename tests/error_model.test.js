// US-1707 — the error model, end to end. Every failure in the chain (page →
// bridge → worker → device) has a name and a next step; the D13 vocabulary
// is covered by one table-driven test; error names revive across the
// postMessage boundary; and no untyped rejection escapes the worker.

import test from 'node:test';
import assert from 'node:assert/strict';

import { SW as CORE_SW } from '../src/core/ctaphid.js';
import { SW as WIRE, NOSTR_CMD } from './fixtures/nostr_wire_d15abe7.js';
import { describeSw } from '../src/worker/error-map.js';
import { serializeError, reviveError } from '../src/worker/errors.js';
import { createDispatch } from '../src/worker/dispatch.js';
import { serializeBridgeError, reviveBridgeError } from '../src/core/window_nostr.js';
import { DeviceAbsentError } from '../src/core/loudness.js';

test('US-1707 the mapping table covers every word in the D13 vocabulary', () => {
  // 15 distinct words cross the transport (the fixture pins them — the PIN
  // custody words 0x6982 and 0x63c0 joined at US-1705, the ceremony words
  // 0x6f01 and 0x6f02 at US-1714); the map has a row for each — 0x9000
  // included, so a spurious OK sentence cannot hide.
  const words = new Set(Object.values(WIRE));
  for (const sw of words) {
    assert.ok(describeSw(sw).known, `0x${sw.toString(16)} must have a row`);
    assert.ok(
      sw === 0x9000 || describeSw(sw).message.length > 8,
      `the sentence for 0x${sw.toString(16)} says something`,
    );
  }
  assert.equal(words.size, 15);
});

test('US-1707 the table-driven rows: each SW maps to its named sentence', () => {
  const rows = [
    [0x6985, 'touch timed out — the device asked for a touch and none came'],
    [0x6a84, 'that slot is occupied — delete it first'],
    [0x6a82, 'that identity is not on the device — or, on a PIN verb, there is no PIN set yet'],
    [0x6f00, 'the device could not complete the operation — its store faulted'],
    [0x6d00, 'the device does not serve that command'],
    [0x6a80, 'the device refused the data — it could not read the request'],
  ];
  for (const [sw, sentence] of rows) {
    assert.equal(describeSw(sw).message, sentence);
    assert.ok(describeSw(sw).code.startsWith('SW_'));
  }
});

test('US-1707 an unknown SW is still typed: device-error with the hex in the sentence', () => {
  const m = describeSw(0x1234);
  assert.equal(m.known, false);
  assert.equal(m.code, 'device-error');
  assert.match(m.message, /0x1234/);
  assert.ok(!m.message.includes('undefined'));
});

test('US-1707 the touch word carries the two sentences its two causes make', () => {
  // Cause 1: the 15 s window closed with no press (the transport's own
  // timeout produces the same typed word at the CtapError layer).
  assert.match(describeSw(0x6985).message, /touch timed out/);
  // Cause 2 (never provoked by the queue): the second-request refusal is
  // the same word — the worker's queue means the page never sees it, which
  // the serialization tests assert.
});

test('US-1707 the port boundary serializes only the typed vocabulary', () => {
  // The known types cross with their name and code:
  const absent = serializeError(new DeviceAbsentError());
  assert.equal(absent.name, 'DeviceAbsentError');
  assert.equal(absent.code, 'DEVICE_ABSENT');
  // A raw TypeError is rebranded — the page never guesses at internals:
  const raw = serializeError(new TypeError('Cannot read properties of undefined'));
  assert.equal(raw.name, 'InternalError');
  assert.equal(raw.code, 'internal-error');
  // A thrown string is typed too:
  const thrown = serializeError('boom');
  assert.equal(thrown.name, 'InternalError');
  assert.equal(thrown.code, 'internal-error');
  assert.equal(thrown.message, 'boom');
  // Revival keeps the shape:
  const back = reviveError(absent);
  assert.equal(back.name, 'DeviceAbsentError');
  assert.equal(back.code, 'DEVICE_ABSENT');
});

test('US-1707 no untyped rejection escapes the worker — fuzz-ish random throws', async () => {
  const junk = [
    new TypeError('random'),
    Object.assign(new Error('x'), { name: 'SecurityError' }),
    'a thrown string',
    { weird: 'object' },
    42,
    null,
  ];
  const dispatch = createDispatch(
    {
      sign_event: async () => {
        throw junk[Math.floor(Math.random() * junk.length)];
      },
    },
    { extensionId: 'test' },
  );
  for (let i = 0; i < 24; i++) {
    const reply = await dispatch(
      { id: i, method: 'sign_event', args: [] },
      { url: 'https://tab.example/' },
    );
    assert.ok(reply.error, 'every throw is an error reply');
    assert.ok(
      reply.error.code !== undefined && reply.error.name !== undefined,
      'typed: ' + JSON.stringify(reply.error),
    );
    // Nothing raw crosses: the page-visible name is from the vocabulary.
    assert.ok(
      ['InternalError', 'DeviceAbsentError', 'SwError', 'SignerError', 'CtapError'].includes(reply.error.name) ||
        reply.error.code === 'forbidden-method',
      JSON.stringify(reply.error),
    );
  }
});

test('US-1707 error names revive across the provider boundary (postMessage)', () => {
  // What the worker serialized is what the page's provider revives.
  const original = new DeviceAbsentError('Fapico board');
  const blob = serializeBridgeError(original);
  const revived = reviveBridgeError(blob);
  assert.equal(revived.name, 'DeviceAbsentError');
  assert.equal(revived.code, 'DEVICE_ABSENT');
  const sw = serializeBridgeError(Object.assign(new Error('refused'), { name: 'SwError', sw: 0x6985, code: 'SW_6985' }));
  const swBack = reviveBridgeError(sw);
  assert.equal(swBack.name, 'SwError');
  assert.equal(swBack.sw, 0x6985);
});

test('US-1707 the provider-level revival preserves the name across a simulated frame', async () => {
  // Wire the provider to a responder that rejects with a worker-serialized
  // error — the exact shape a real chain produces.
  const { installProvider } = await import('../src/provider/provider.js');
  const { NOSTR_MARKER } = await import('../src/shared/protocol.js');
  const listeners = [];
  const win = {
    location: { host: 'x.example', origin: 'https://x.example' },
    addEventListener: (t, f) => listeners.push(f),
    postMessage: (d) => setImmediate(() => listeners.forEach((f) => f({ source: win, data: d }))),
  };
  installProvider(win);
  listeners.push((ev) => {
    const d = ev.data;
    if (!d || d.marker !== NOSTR_MARKER || d.dir !== 'call') return;
    setImmediate(() =>
      win.postMessage(
        { marker: NOSTR_MARKER, dir: 'reply', id: d.id, reply: { error: serializeError(new DeviceAbsentError()) } },
        win.location.origin,
      ),
    );
  });
  await assert.rejects(
    () => win.nostr.getPublicKey(),
    (err) => {
      assert.equal(err.name, 'DeviceAbsentError', 'the typed name survives the whole chain');
      assert.equal(err.code, 'DEVICE_ABSENT');
      return true;
    },
  );
});
