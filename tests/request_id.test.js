// US-1735 — requestId: one namespace, not per-connection counters. Frame ids
// are per-connection counters (the provider's `p0…` per page, the port
// client's `c0…` per popup) while the worker's request maps are global, so
// two tabs' concurrent first consent-gated calls both arrive as `p0` and the
// second overwrites the first in every map. The dispatch builds the
// composite `${port.name}/${frame.id}` at its single boundary; replies keep
// echoing the BARE frame id (the bridge and provider match replies by it).

import test from 'node:test';
import assert from 'node:assert/strict';

import { createDispatch } from '../src/worker/dispatch.js';
import { createPromptFlow } from '../src/worker/prompt.js';
import { createConsentGate } from '../src/worker/consent.js';
import { createPermissionStore } from '../src/worker/permissions.js';

const EXT_ID = 'test-extension-id';
const trustedSender = { url: `chrome-extension://${EXT_ID}/popup.html` };
const tabSender = (host) => ({ url: `https://${host}/post` });
const fakePort = (name) => ({ name, postMessage() {} });

function fakeWindows() {
  const removedListeners = [];
  let nextId = 100;
  const created = [];
  const removedIds = new Set();
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
    remove: async (id) => fireRemoved(id),
    onRemoved: { addListener: (fn) => removedListeners.push(fn) },
  };
}

function fakeStorage() {
  const data = new Map();
  return {
    async get(k) { const out = {}; for (const key of [].concat(k)) if (data.has(key)) out[key] = data.get(key); return out; },
    async set(o) { for (const [k, v] of Object.entries(o)) data.set(k, v); },
    async remove(k) { data.delete(k); },
  };
}

test('US-1735 two connections, same frame id — each handler sees its own composite requestId', async () => {
  const seen = [];
  const dispatch = createDispatch(
    { sign_event: async (args, ctx) => { seen.push(ctx.requestId); return {}; } },
    { extensionId: EXT_ID },
  );
  const frame = { id: 'p0', method: 'sign_event', args: [{ kind: 1 }] };
  await dispatch(frame, tabSender('a.example'), fakePort('nostr-abc'));
  await dispatch(frame, tabSender('b.example'), fakePort('nostr-def'));
  assert.deepEqual(seen, ['nostr-abc/p0', 'nostr-def/p0'],
    'the same frame id on two ports never collides');
});

test('US-1735 the reply frame still echoes the BARE frame id (the bridge matches replies by it)', async () => {
  const dispatch = createDispatch({ echo: async (args) => ({ echoed: args }) }, { extensionId: EXT_ID });
  const reply = await dispatch(
    { id: 'p0', method: 'echo', args: ['hi'] },
    trustedSender,
    fakePort('nostr-page-1'),
  );
  assert.equal(reply.id, 'p0', 'the reply id is the frame id, never the composite');
});

test('US-1735 a route without a port (direct invocation, the test-runner shape) keeps the bare frame id', async () => {
  const seen = [];
  const dispatch = createDispatch(
    { sign_event: async (args, ctx) => { seen.push(ctx.requestId); return {}; } },
    { extensionId: EXT_ID },
  );
  await dispatch({ id: 'p0', method: 'sign_event', args: [] }, tabSender('a.example'));
  assert.deepEqual(seen, ['p0']);
});

// The collision repro: two concurrent consent-gated calls with the SAME frame
// id on two bridge ports. Today the second ask() overwrites the first record
// — approving A resolves B and A hangs. The composite keeps both requests
// distinct end to end.
test('US-1735 two concurrent prompts with the same frame id stay distinct — approving A never resolves B', async () => {
  const windows = fakeWindows();
  const prompt = createPromptFlow({ windows });
  const permissions = createPermissionStore({ storage: fakeStorage() });
  const consent = createConsentGate({
    permissions,
    prompt,
    hostOf: (sender) => new URL(sender.url).host,
  });
  const dispatch = createDispatch(
    {
      sign_event: async (args, ctx) =>
        consent({ method: 'sign_event', args, sender: ctx.sender, requestId: ctx.requestId }),
    },
    { extensionId: EXT_ID },
  );

  const frame = { id: 'p0', method: 'sign_event', args: [{ kind: 1 }] };
  const gateA = dispatch(frame, tabSender('a.example'), fakePort('nostr-tab-a'));
  const gateB = dispatch({ ...frame }, tabSender('b.example'), fakePort('nostr-tab-b'));
  await new Promise((r) => setImmediate(r)); // let both ask()s register

  assert.equal(windows.created.length, 2, 'two distinct prompt windows are open');

  // The prompt page derives its requestId from the window URL — round-trip
  // it. Creation order is nondeterministic under concurrent dispatches, so
  // each window is identified by ITS OWN url, never by creation index.
  const reqOf = (win) => new URL(win.opts.url, 'https://ext/').searchParams.get('request');
  const requestIdA = windows.created.map(reqOf).find((rq) => rq.startsWith('nostr-tab-a/'));
  const requestIdB = windows.created.map(reqOf).find((rq) => rq.startsWith('nostr-tab-b/'));
  assert.equal(requestIdA, 'nostr-tab-a/p0', 'the composite survives the URL encoding');
  assert.equal(requestIdB, 'nostr-tab-b/p0');

  await prompt.decide({ requestId: requestIdA, approve: true, remember: false });
  // A's decision granted A's consent — the dispatch reply carries the result.
  const replyA = await gateA;
  assert.equal(replyA.id, 'p0', 'A’s reply echoes the bare frame id');
  assert.equal(replyA.result?.host, 'a.example', 'A’s consent resolved, not B’s');

  // B is still waiting on its own window — no reply from A's approval.
  const bOutcome = gateB.then(() => 'replied', () => 'replied');
  const winner = await Promise.race([bOutcome, new Promise((r) => setTimeout(() => r('pending'), 20))]);
  assert.equal(winner, 'pending', "B's consent is still outstanding after A's approval");

  // B's own window close denies B typed — the close-before-approve invariant.
  // At the dispatch level a typed denial is a RESOLVED {id, error} reply (the
  // bridge matches replies by id), never a hang and never a result.
  await windows.close(windows.created.find((w) => reqOf(w) === requestIdB).id);
  const replyB = await gateB;
  assert.equal(replyB.id, 'p0', 'B’s reply echoes the bare frame id');
  assert.equal(replyB.error?.code, 'user-denied', "closing B's own window denies B typed");
});
