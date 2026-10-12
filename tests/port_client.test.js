// US-1721 — the port client now forwards worker push frames ({event, ...}, no
// id) to onEvent listeners and surfaces a disconnected port via onDisconnect,
// without touching the id-matched reply routing (US-1692). No real chrome.port
// in Node, so the port is a tiny in-memory double: postMessage records the
// page→worker frames, and the test drives worker→page messages/disconnect
// through the recorded listeners directly.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createPortClient } from '../src/shared/port-client.js';

function rig() {
  const messageListeners = [];
  const disconnectListeners = [];
  const posted = [];
  const chrome_ = {
    runtime: {
      connect: () => ({
        portName: 'test-port',
        onMessage: { addListener: (fn) => messageListeners.push(fn) },
        onDisconnect: { addListener: (fn) => disconnectListeners.push(fn) },
        postMessage: (msg) => posted.push(msg),
      }),
    },
  };
  const client = createPortClient({ chrome_, name: 'nostr-test' });
  return {
    client,
    posted,
    // a frame the worker would postMessage to the page
    push(msg) {
      for (const fn of messageListeners) fn(msg);
    },
    // a framed reply (has an id) the worker would postMessage to the page
    reply(msg) {
      for (const fn of messageListeners) fn(msg);
    },
    disconnect() {
      for (const fn of disconnectListeners) fn();
    },
  };
}

test('US-1721 a push frame (no id) reaches the onEvent listener verbatim', () => {
  const r = rig();
  const seen = [];
  r.client.onEvent((frame) => seen.push(frame));
  r.push({ event: 'prompt-settled', requestId: 'r1' });
  assert.deepEqual(seen, [{ event: 'prompt-settled', requestId: 'r1' }]);
});

test('US-1721 unknown push frames are passed through untouched and never routed to a pending call', () => {
  const r = rig();
  let pendingResolved = false;
  r.client.call('get_active_slot').then(() => {
    pendingResolved = true;
  });
  const seen = [];
  r.client.onEvent((frame) => seen.push(frame));
  r.push({ some: 'unknown frame', noEvent: true });
  assert.deepEqual(seen, [{ some: 'unknown frame', noEvent: true }]);
  assert.equal(pendingResolved, false, 'a no-id frame never resolves a pending call');
});

test('US-1721 onDisconnect fires when the port disconnects', () => {
  const r = rig();
  let fired = 0;
  r.client.onDisconnect(() => {
    fired += 1;
  });
  r.disconnect();
  assert.equal(fired, 1);
});

test('US-1721 a reply frame (with id) resolves its pending call and never hits the push listener', async () => {
  const r = rig();
  let sawPush = false;
  r.client.onEvent(() => {
    sawPush = true;
  });
  const promise = r.client.call('get_active_slot'); // pending id is c0 (seq starts at 0)
  r.reply({ id: 'c0', method: 'get_active_slot', result: { slot: 2 } });
  const result = await promise;
  assert.deepEqual(result, { slot: 2 });
  assert.equal(sawPush, false, 'a framed reply never reaches the onEvent listener');
});

test('US-1721 an id with no pending call is ignored — no throw, no listener', () => {
  const r = rig();
  let sawPush = false;
  r.client.onEvent(() => {
    sawPush = true;
  });
  assert.doesNotThrow(() => {
    r.reply({ id: 'nope', method: 'x', result: 1 });
  });
  assert.equal(sawPush, false);
});

test('US-1721 onEvent and onDisconnect return an unsubscribe that stops delivery', () => {
  const r = rig();
  const seen = [];
  const off = r.client.onEvent((frame) => seen.push(frame));
  r.push({ event: 'a' });
  off();
  r.push({ event: 'b' });
  assert.deepEqual(seen, [{ event: 'a' }]);

  let disconnected = 0;
  const offD = r.client.onDisconnect(() => {
    disconnected += 1;
  });
  offD();
  r.disconnect();
  assert.equal(disconnected, 0);
});
