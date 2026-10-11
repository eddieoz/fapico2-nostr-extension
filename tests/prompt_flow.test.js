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
  return {
    created,
    create: async (opts) => {
      const win = { id: nextId++, opts };
      created.push(win);
      return win;
    },
    close: async (id) => removedListeners.forEach((fn) => fn(id)),
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
