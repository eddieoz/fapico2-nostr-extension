// US-1700 — the approval prompt window: context before the touch. Approve
// resolves; Deny or closing the window rejects typed `user-denied`; the
// device call happens only after the approval decision (call-order
// assertion); the prompt never receives or displays plaintext of a decrypt.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPromptFlow, buildPreview } from '../src/worker/prompt.js';
import { createConsentGate } from '../src/worker/consent.js';
import { createPermissionStore } from '../src/worker/permissions.js';

function fakeWindows() {
  const removedListeners = [];
  let nextId = 100;
  const created = [];
  const removedIds = new Set();
  // US-1722/US-1723 — firing onRemoved for a window that is already gone is a
  // benign race, so the guard makes a second close/remove inert (swallowed).
  function fireRemoved(id) {
    if (removedIds.has(id)) return;
    removedIds.add(id);
    for (const fn of [...removedListeners]) fn(id);
  }
  return {
    created,
    create: async (opts) => {
      const win = { id: nextId++, opts };
      created.push(win);
      return win;
    },
    close: async (id) => fireRemoved(id),
    // US-1723 — the settle path closes the window through this.
    remove: async (id) => fireRemoved(id),
    get removedCount() {
      return removedIds.size;
    },
    onRemoved: { addListener: (fn) => removedListeners.push(fn) },
  };
}

test('US-1700 approve resolves the request; the persisted decision lands in the store', async () => {
  const windows = fakeWindows();
  const prompt = createPromptFlow({ windows, now: () => 0 });
  const permissions = createPermissionStore({ storage: fakeStorage() });
  const consent = createConsentGate({ permissions, prompt, hostOf: () => 'h.example' });
  const gate = consent({
    method: 'sign_event',
    args: [{ kind: 1 }],
    sender: { url: 'https://h.example/post' },
    requestId: 'r1',
  });
  await new Promise((r) => setImmediate(r)); // let ask() register the promise

  assert.equal(windows.created.length, 1, 'the prompt window opened');
  assert.equal(windows.created[0].opts.type, 'popup');
  await prompt.decide({ requestId: 'r1', approve: true, remember: true });
  await gate;
  assert.equal(await permissions.check('h.example', 'sign_event'), 'persisted',
    'approve with remember persists the grant');
});

function fakeStorage() {
  const data = new Map();
  return {
    async get(k) { const out = {}; for (const key of [].concat(k)) if (data.has(key)) out[key] = data.get(key); return out; },
    async set(o) { for (const [k, v] of Object.entries(o)) data.set(k, v); },
    async remove(k) { data.delete(k); },
  };
}

test('US-1700 deny rejects typed user-denied', async () => {
  const prompt = createPromptFlow({ windows: fakeWindows() });
  const decision = prompt.ask({ requestId: 'r2', method: 'get_public_key', host: 'h.example', preview: 'x' });
  await new Promise((r) => setImmediate(r));
  await prompt.decide({ requestId: 'r2', approve: false });
  await assert.rejects(() => decision, (err) => err.code === 'user-denied' && err.name === 'UserDeniedError');
});

test('US-1700 closing the window is an explicit reject — never a hang', async () => {
  const windows = fakeWindows();
  const prompt = createPromptFlow({ windows });
  const decision = prompt.ask({ requestId: 'r3', method: 'sign_event', host: 'h.example', preview: 'x' });
  await new Promise((r) => setImmediate(r));
  const winId = windows.created[0].id;
  await windows.close(winId);
  await assert.rejects(() => decision, (err) => err.code === 'user-denied');
});

test('US-1700 the device call happens only after the approval decision (call order)', async () => {
  const windows = fakeWindows();
  const prompt = createPromptFlow({ windows });
  const permissions = createPermissionStore({ storage: fakeStorage() });
  const consent = createConsentGate({ permissions, prompt, hostOf: () => 'h.example' });
  const order = [];
  const deviceCall = async () => order.push('device');
  const sender = { url: 'https://h.example/post' };

  const gatePromise = consent({ method: 'sign_event', args: [{ kind: 1, content: 'x' }], sender, requestId: 'r4' });
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(order, [], 'no device call while the prompt is open');
  assert.equal(windows.created.length, 1, 'the prompt is what is open');

  const decisionPromise = prompt.decide({ requestId: 'r4', approve: true, remember: false });
  await decisionPromise;
  await gatePromise;
  await deviceCall();
  assert.deepEqual(order, ['device'], 'the device ran only after approval');
});

test('US-1700 the prompt preview for nip44 never contains the plaintext', () => {
  const plaintext = 'SECRET MEETING AT DAWN';
  const preview = buildPreview('nip44_decrypt', ['aabbccddeeff00112233', 'c2VjcmV0IHBsYWludGV4dA']);
  assert.ok(!preview.includes('SECRET'), 'no plaintext in the preview');
  assert.ok(!preview.includes('c2VjcmV0'), 'no raw payload in the preview');
  assert.ok(/decrypts/.test(preview));
  const encPreview = buildPreview('nip44_encrypt', ['aabbccddeeff00112233', Buffer.from(plaintext).toString('hex')]);
  assert.ok(!encPreview.includes('SECRET') && !encPreview.includes(plaintext.toLowerCase()),
    'the encrypt preview names length and peer, not the text');
});

test('US-1700 the signEvent preview names the kind and a one-line content summary', () => {
  const p = buildPreview('sign_event', [{ kind: 1, content: 'hello\nworld  this is a longish note that keeps going on and on and on' }]);
  assert.ok(p.startsWith('signs a short text note'), p);
  assert.ok(p.includes('hello world'), 'the content summary is one line');
  assert.ok(p.length < 130, 'the summary is a summary');
  assert.equal(buildPreview('sign_event', [{ kind: 9999, content: '' }]), 'signs a kind 9999');
});

test('US-1700 a decision for an unknown or already-settled request is inert', async () => {
  const prompt = createPromptFlow({ windows: fakeWindows() });
  assert.deepEqual(await prompt.decide({ requestId: 'ghost', approve: true }), { delivered: false });
});

// US-1722 — the approval window stays open through the touch. Approve resolves
// the consent promise exactly once and moves the record to awaiting-settle; a
// window close AFTER approval is therefore a no-op (never a user-denied reject),
// while a close BEFORE approval still rejects typed (the invariant above).
test('US-1722 approve keeps the record awaiting-settle — a later window close never rejects', async () => {
  const windows = fakeWindows();
  const prompt = createPromptFlow({ windows, now: () => 42 });
  const decision = prompt.ask({ requestId: 'r5', method: 'sign_event', host: 'h.example', preview: 'x' });
  await new Promise((r) => setImmediate(r));

  assert.equal(prompt.outstandingCount, 1, 'outstanding before the decision');
  await prompt.decide({ requestId: 'r5', approve: true, remember: false });
  assert.deepEqual(await decision, { approved: true, remember: false, at: 42 }, 'resolves exactly once');
  assert.equal(prompt.outstandingCount, 0, 'no longer outstanding after approval');
  assert.equal(prompt.awaitingSettleCount, 1, 'the record is kept, awaiting settle');

  // US-1722 — the window closes AFTER approval (and a second remove is swallowed):
  // neither may reject the resolved promise or resurrect the record.
  await windows.close(windows.created[0].id);
  await windows.remove(windows.created[0].id);
  assert.equal(prompt.awaitingSettleCount, 1, 'post-approval close is a no-op');
});

test('US-1722 a window closed BEFORE approval still rejects typed user-denied', async () => {
  const windows = fakeWindows();
  const prompt = createPromptFlow({ windows });
  const decision = prompt.ask({ requestId: 'r6', method: 'sign_event', host: 'h.example', preview: 'x' });
  await new Promise((r) => setImmediate(r));
  await windows.close(windows.created[0].id);
  await assert.rejects(() => decision, (err) => err.code === 'user-denied');
  assert.equal(prompt.awaitingSettleCount, 0, 'nothing moved to awaiting-settle');
});

// US-1723 — the device op settled. The outcome is pushed to the request's
// window port and, after a visible beat, the window is closed. A settle for an
// unknown requestId (a worker restart ate the map) is inert — no throw, no
// push, no resurrection; remove on an already-closed window is swallowed.
test('US-1723 settle(ok) pushes the outcome frame and schedules the close after the beat', async () => {
  const windows = fakeWindows();
  const delivered = [];
  const prompt = createPromptFlow({ windows, now: () => 0, beatMs: 0, deliver: (id, frame) => delivered.push([id, frame]) });
  const decision = prompt.ask({ requestId: 'r1', method: 'sign_event', host: 'h.example', preview: 'x' });
  await new Promise((r) => setImmediate(r));
  await prompt.decide({ requestId: 'r1', approve: true });

  assert.equal(prompt.awaitingSettleCount, 1);
  const before = windows.removedCount;
  await prompt.settle('r1', 'ok');
  assert.deepEqual(delivered, [['r1', { event: 'prompt-settled', requestId: 'r1', outcome: 'ok' }]], 'the outcome frame is pushed');
  assert.equal(prompt.awaitingSettleCount, 0, 'the record is dropped once settled');
  assert.equal(windows.removedCount, before, 'the close is scheduled, not immediate');
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(windows.removedCount, before + 1, 'the window closes after the beat');
});

test('US-1723 settle(err, message) pushes the typed error sentence', async () => {
  const windows = fakeWindows();
  const delivered = [];
  const prompt = createPromptFlow({ windows, beatMs: 0, deliver: (_id, frame) => delivered.push(frame) });
  const decision = prompt.ask({ requestId: 'r2', method: 'sign_event', host: 'h.example', preview: 'x' });
  await new Promise((r) => setImmediate(r));
  await prompt.decide({ requestId: 'r2', approve: true });

  await prompt.settle('r2', 'err', 'the touch timed out');
  assert.deepEqual(delivered[0], { event: 'prompt-settled', requestId: 'r2', outcome: 'err', message: 'the touch timed out' });
});

test('US-1723-err settle(err) leaves the window open — the sentence is the diagnosis', async () => {
  // The chat.nostr.com field report: an encrypt approved, the board never
  // armed, and the typed refusal flashed for one beat before the window
  // closed — the operator never saw WHICH sentence the device answered.
  // A failure keeps the window (and its sentence) until the user closes it;
  // only a success auto-closes after the beat.
  const windows = fakeWindows();
  const prompt = createPromptFlow({ windows, beatMs: 0, deliver: () => {} });
  const decision = prompt.ask({ requestId: 'r9', method: 'nip44_encrypt', host: 'h.example', preview: 'x' });
  await new Promise((r) => setImmediate(r));
  await prompt.decide({ requestId: 'r9', approve: true });

  const before = windows.removedCount;
  await prompt.settle('r9', 'err', 'the device requires its PIN before this operation — verify to continue');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(windows.removedCount, before, 'no scheduled close for an error — the sentence stays readable');
});

test('US-1725 concurrent asks serialize — one prompt window at a time, released at settle', async () => {
  // The reinstall field report: a fresh install has no grants, the site
  // fires get_public_key + nip44 + auth signs at once, and every ungranted
  // call opened its OWN window — a popup storm where each approved window
  // then queued behind the others for the single device. The consent line:
  // exactly one window at a time; the next opens only after the previous
  // request's device op settles (or its ask rejects — deny/close). Consent
  // is never weakened: every request still gets its own window and decision.
  const windows = fakeWindows();
  const prompt = createPromptFlow({ windows, beatMs: 0, deliver: () => {} });
  const d1 = prompt.ask({ requestId: 's1', method: 'get_public_key', host: 'h.example', preview: 'x' });
  const d2 = prompt.ask({ requestId: 's2', method: 'nip44_encrypt', host: 'h.example', preview: 'x' });
  const d3 = prompt.ask({ requestId: 's3', method: 'sign_event', host: 'h.example', preview: 'x' });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(windows.created.length, 1, 'only the FIRST request opens a window');

  await prompt.decide({ requestId: 's1', approve: true });
  await d1; // the decision resolved — but the device op has not settled yet
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(windows.created.length, 1, 'the second window waits for the first device op');

  await prompt.settle('s1', 'ok');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(windows.created.length, 2, 'after the settle, the next window opens');

  await prompt.decide({ requestId: 's2', approve: false }); // a deny settles the line immediately
  await assert.rejects(() => d2, (e) => e.code === 'user-denied');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(windows.created.length, 3, 'a denial releases the line for the next request');

  await prompt.decide({ requestId: 's3', approve: true });
  await prompt.settle('s3', 'err', 'touch timed out — the device asked for a touch and none came');
  await d3;
  assert.equal(windows.created.length, 3, 'an error settle releases the line too (its window stays, the line moves on)');
});

test('US-1725 a failed window create never wedges the consent line (review R-1)', async () => {
  // windows.create can reject (window-count limits, the worker-unload race).
  // The ask fails typed — and the line MUST release, or every future prompt
  // from every site hangs with no window, permanently. The resolver is a
  // no-op after its first call, so an unconditional release is safe.
  const windows = fakeWindows();
  const baseCreate = windows.create.bind(windows);
  let failOnce = true;
  windows.create = async (opts) => {
    if (failOnce) {
      failOnce = false;
      throw new Error('window limit reached');
    }
    return baseCreate(opts);
  };
  const prompt = createPromptFlow({ windows, beatMs: 0, deliver: () => {} });

  await assert.rejects(
    () => prompt.ask({ requestId: 'w1', method: 'sign_event', host: 'h.example', preview: 'x' }),
    /window limit/,
    'the failed ask rejects',
  );

  const d2 = prompt.ask({ requestId: 'w2', method: 'sign_event', host: 'h.example', preview: 'x' });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(windows.created.length, 1, 'the next ask opened its window — the line was released, not held');
  await prompt.decide({ requestId: 'w2', approve: false });
  await assert.rejects(() => d2, (e) => e.code === 'user-denied');
});

test('US-1725 a failed decision write never wedges the consent line (review R-2)', async () => {
  // Between decide(approve) and the handler's notifySettle, the consent gate
  // persists the grant and the pending record — both can reject (storage
  // quota). The request must fail typed AND the line must move: nothing else
  // would settle the awaitingSettle record, so a throw there used to hold
  // the line forever with no recovery path in-process.
  const windows = fakeWindows();
  const prompt = createPromptFlow({ windows, beatMs: 0, deliver: () => {} });
  const storage = fakeStorage();
  const rawSet = storage.set.bind(storage);
  let failOnce = true;
  storage.set = async (obj) => {
    if (failOnce && obj && Object.hasOwn(obj, 'grants')) {
      failOnce = false;
      throw new Error('storage quota exceeded');
    }
    return rawSet(obj);
  };
  const permissions = createPermissionStore({ storage });
  const consent = createConsentGate({ permissions, prompt, hostOf: () => 'h.example' });
  const sender = { url: 'https://h.example/post' };

  const g1 = consent({ method: 'sign_event', args: [{ kind: 1 }], sender, requestId: 'g1' });
  await new Promise((r) => setImmediate(r));
  await prompt.decide({ requestId: 'g1', approve: true, remember: true });
  await assert.rejects(() => g1, /storage quota/, 'the request fails typed, not hung');

  const g2 = consent({ method: 'sign_event', args: [{ kind: 1 }], sender, requestId: 'g2' });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(windows.created.length, 2, "the next request's window opened — the line was not held");
  await prompt.decide({ requestId: 'g2', approve: false });
  await assert.rejects(() => g2, (e) => e.code === 'user-denied');
});

test('US-1723 settle for an unknown requestId is inert — no throw, no push, no resurrection', async () => {
  const windows = fakeWindows();
  const delivered = [];
  const prompt = createPromptFlow({ windows, beatMs: 0, deliver: (_id, frame) => delivered.push([_id, frame]) });

  assert.deepEqual(await prompt.settle('ghost', 'ok'), { delivered: false });
  assert.deepEqual(delivered, [], 'nothing pushed');
  assert.equal(prompt.awaitingSettleCount, 0, 'no state resurrected');
});

test('US-1723 settle after the window already closed swallows the remove', async () => {
  const windows = fakeWindows();
  const prompt = createPromptFlow({ windows, beatMs: 0, deliver: (_id, frame) => {} });
  const decision = prompt.ask({ requestId: 'r3', method: 'sign_event', host: 'h.example', preview: 'x' });
  await new Promise((r) => setImmediate(r));
  await prompt.decide({ requestId: 'r3', approve: true });
  await windows.close(windows.created[0].id); // gone before settle

  assert.deepEqual(await prompt.settle('r3', 'ok'), { delivered: true }, 'settle still resolves');
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(windows.removedCount, 1, 'the post-close remove is swallowed, not double-counted');
});
