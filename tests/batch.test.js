// US-1672 — batched decryption that never marks a miss as done; SW
// suspension covered (design D14, §2.3, §A.8.3b). One user gesture decrypts
// the visible set; each item stays individually touch-gated; a missed item
// is reported and retried rather than marked done; and a service-worker
// suspension mid-ceremony fails closed with a typed CEREMONY_INTERRUPTED —
// distinct from DEVICE_ABSENT and from refusals.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CeremonyInterruptedError,
  TOUCH_WINDOW_MS,
  decryptBatch,
  startKeepalive,
  startWindowCountdown,
} from '../src/core/batch.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('US-1672 worker_termination_strands_nothing_silently — fails closed, typed, nothing marked', async () => {
  const attempts = [];
  const marked = [];
  let keepaliveTicks = 0;
  const keepalive = startKeepalive({
    periodMs: 1,
    tick: () => {
      keepaliveTicks += 1;
    },
  });

  const decryptOne = async (item) => {
    attempts.push(item.id);
    if (item.id === 'A') return `pt-${item.id}`;
    if (item.id === 'B') {
      // The service worker dies mid-ceremony, after a real press: the
      // ceremony does not resume, the device fails closed.
      keepalive.stop();
      throw new CeremonyInterruptedError();
    }
    throw new Error('C must never be attempted after an interruption');
  };

  const result = await decryptBatch({
    items: [{ id: 'A' }, { id: 'B' }, { id: 'C' }],
    decryptOne,
    markDone: (item) => marked.push(item.id),
    keepaliveTick: keepalive.tick,
  });

  assert.deepEqual(marked, ['A'], 'only the item that really decrypted is marked done');
  assert.deepEqual(attempts, ['A', 'B'], 'the interrupted item was attempted, C was not');
  assert.equal(result.done.length, 1);
  assert.equal(result.interrupted.item.id, 'B');
  assert.equal(result.interrupted.error.code, 'CEREMONY_INTERRUPTED');
  // Typed and distinct: not absence, not a refusal.
  assert.notEqual(result.interrupted.error.code, 'DEVICE_ABSENT');
  assert.notEqual(result.interrupted.error.code, 'SW_6985');
  // B is not marked done and not silently dropped — it is reported.
  assert.equal(result.missed.length, 0);
  // The keepalive loop is dead — the SW hold does not outlive the ceremony.
  const frozen = keepaliveTicks;
  await sleep(20);
  assert.equal(keepaliveTicks, frozen, 'the keepalive stopped with the ceremony');
});

test('US-1672 a missed item is retried, not marked processed', async () => {
  const marked = [];
  const reported = [];
  let firstAttemptFailed = true;

  const result = await decryptBatch({
    items: [{ id: 'A' }, { id: 'window-expired' }],
    decryptOne: async (item) => {
      if (item.id === 'window-expired' && firstAttemptFailed) {
        firstAttemptFailed = false;
        throw new Error('touch window expired'); // e.g. the 15 s lapsed
      }
      return `pt-${item.id}`;
    },
    isDone: (item) => false,
    markDone: (item) => marked.push(item.id),
    onRetry: (item, err) => reported.push({ id: item.id, error: err.message }),
    passes: 1,
  });

  // The miss was reported...
  assert.deepEqual(reported, [{ id: 'window-expired', error: 'touch window expired' }]);
  // ...and the retry pass re-attempted it — and only then marked it.
  assert.deepEqual(marked, ['A', 'window-expired']);
  assert.equal(result.done.length, 2);
  assert.equal(result.missed.length, 0);
});

test('US-1672 an item that keeps failing is reported, never marked done', async () => {
  const marked = [];
  const attempts = [];

  const result = await decryptBatch({
    items: [{ id: 'A' }, { id: 'B' }],
    decryptOne: async (item) => {
      attempts.push(item.id);
      if (item.id === 'B') throw new Error('refused again');
      return `pt-${item.id}`;
    },
    markDone: (item) => marked.push(item.id),
    passes: 1,
  });

  assert.deepEqual(attempts, ['A', 'B', 'B'], 'A once, B once then one retry pass');
  assert.deepEqual(marked, ['A']);
  assert.equal(result.missed[0].item.id, 'B');
  assert.equal(result.missed[0].error.message, 'refused again');
});

test('US-1672 each item is individually touch-gated: no item shares a ceremony', async () => {
  const ceremonies = [];
  await decryptBatch({
    items: [{ id: 'A' }, { id: 'B' }, { id: 'C' }],
    decryptOne: async (item) => {
      ceremonies.push(item.id);
      return `pt-${item.id}`;
    },
  });
  assert.deepEqual(ceremonies, ['A', 'B', 'C'], 'one gate per item, sequentially');
});

// Mocked timers: a 1 ms loop asserted against a 15 ms wall-clock window
// starves under a loaded runner (8 concurrent test files) — the assertion
// must not depend on scheduler fairness.
test('US-1672 the keepalive holds the service worker for the ceremony and stops cleanly', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let ticks = 0;
  const keepalive = startKeepalive({ periodMs: 1, tick: () => (ticks += 1) });
  t.mock.timers.tick(10);
  assert.ok(ticks > 3, 'the loop ticked while the ceremony ran');
  keepalive.stop();
  const frozen = ticks;
  t.mock.timers.tick(50);
  assert.equal(ticks, frozen);
  keepalive.stop(); // idempotent
});

test('US-1672 the touch-window countdown reports remaining time and ends at zero', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const ticks = [];
  const countdown = startWindowCountdown({
    windowMs: 40,
    tickMs: 10,
    onTick: (remainingMs) => ticks.push(remainingMs),
  });
  t.mock.timers.tick(40);
  assert.ok(ticks.length >= 3, 'it ticked across the window');
  assert.equal(ticks.at(-1), 0, 'the window ends at zero, not by silence');
  assert.ok(
    ticks.every((r, i) => i === 0 || r <= ticks[i - 1]),
    'remaining time only decreases',
  );
  // The 15 s default is the device's touch window, named once.
  assert.equal(TOUCH_WINDOW_MS, 15_000);
});

// US-1682 — the interrupted batch names its unprocessed remainder: nothing
// completes invisibly, and nothing disappears from the report.

test('US-1682 an interrupted batch names its unprocessed remainder', async () => {
  const attempts = [];
  const result = await decryptBatch({
    items: [{ id: 'A' }, { id: 'B' }, { id: 'C' }],
    decryptOne: async (item) => {
      attempts.push(item.id);
      if (item.id === 'A') throw new CeremonyInterruptedError();
      return `pt-${item.id}`;
    },
  });

  assert.equal(result.interrupted.item.id, 'A');
  assert.equal(result.interrupted.error.code, 'CEREMONY_INTERRUPTED');
  assert.deepEqual(attempts, ['A'], 'nothing after the interruption was attempted');
  // B and C were never attempted — the result must name them as the
  // unattempted remainder, not leave them absent from every list.
  assert.deepEqual(
    result.unprocessed.map((i) => i.id).sort(),
    ['B', 'C'],
    'the unattempted remainder is named, not dropped',
  );
  assert.equal(result.missed.length, 0, 'nothing was attempted-and-failed here');
  // The complete fate of every input item, each in exactly one place.
  const fates = [
    ...result.done.map((i) => i.id),
    ...result.missed.map((m) => m.item.id),
    ...result.unprocessed.map((i) => i.id),
    result.interrupted.item.id,
  ].sort();
  assert.deepEqual(fates, ['A', 'B', 'C'], 'every input item is named exactly once');
});

test('US-1682 the remainder distinguishes unattempted items from attempted misses', async () => {
  const result = await decryptBatch({
    items: [{ id: 'A' }, { id: 'B' }, { id: 'C' }],
    decryptOne: async (item) => {
      if (item.id === 'A') throw new Error('touch window expired');
      if (item.id === 'B') throw new CeremonyInterruptedError();
      throw new Error('C must never be attempted after an interruption');
    },
    passes: 1,
  });

  // A was attempted and failed: a real miss, with its error.
  assert.equal(result.missed.length, 1);
  assert.equal(result.missed[0].item.id, 'A');
  assert.equal(result.missed[0].error.message, 'touch window expired');
  // B is the interrupted item, named where it is — not in missed.
  assert.equal(result.interrupted.item.id, 'B');
  // C was never attempted: unprocessed, not a miss.
  assert.deepEqual(result.unprocessed.map((i) => i.id), ['C']);
});
