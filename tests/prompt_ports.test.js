// US-1736 — the prompt-port registry: bind on connect (keyed by the
// requestId captured from the `nostr-prompt-<requestId>` port name, composite
// keys included — US-1735), drop on disconnect (a closed prompt window never
// accumulates in the worker's map), and a guarded deliver (posting to a dead
// port throws; the settle path must never).

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPromptPortRegistry } from '../src/worker/prompt-ports.js';

const fakePort = (name, { throws = false } = {}) => {
  const received = [];
  return {
    name,
    received,
    postMessage(frame) {
      if (throws) throw new Error('Attempting to use a disconnected port object');
      received.push(frame);
    },
  };
};

test('US-1736 a prompt port binds under the requestId captured from its name — composite included', () => {
  const reg = createPromptPortRegistry();
  const port = fakePort('nostr-prompt-nostr-abc/p0');
  assert.equal(reg.bind(port), 'nostr-abc/p0', 'the composite key is captured whole');
  const frame = { event: 'prompt-settled', requestId: 'nostr-abc/p0', outcome: 'ok' };
  assert.equal(reg.deliver('nostr-abc/p0', frame), true);
  assert.deepEqual(port.received, [frame]);
});

test('US-1736 a non-prompt port binds nothing', () => {
  const reg = createPromptPortRegistry();
  assert.equal(reg.bind(fakePort('nostr-tab-1')), null);
  assert.equal(reg.bind(fakePort('nostr-page-abc')), null);
  assert.equal(reg.deliver('anything', { event: 'x' }), false);
});

test('US-1736 drop removes only that port — a second bound port still receives', () => {
  const reg = createPromptPortRegistry();
  const a = fakePort('nostr-prompt-a');
  const b = fakePort('nostr-prompt-b');
  reg.bind(a);
  reg.bind(b);
  reg.drop(a);
  const frame = { event: 'prompt-settled' };
  assert.equal(reg.deliver('a', frame), false, 'the dropped port is gone');
  assert.equal(reg.deliver('b', frame), true, 'the sibling still receives');
  assert.deepEqual(b.received, [frame]);
  assert.deepEqual(a.received, [], 'the dropped port got nothing');
});

test('US-1736 deliver to a disconnected (throwing) port is swallowed — never throws', () => {
  const reg = createPromptPortRegistry();
  reg.bind(fakePort('nostr-prompt-dead', { throws: true }));
  assert.equal(reg.deliver('dead', { event: 'prompt-settled' }), false);
});

test('US-1736 deliver to an unknown or already-dropped key is inert', () => {
  const reg = createPromptPortRegistry();
  assert.equal(reg.deliver('ghost', { event: 'prompt-settled' }), false);
  assert.equal(reg.deliver(null, { event: 'x' }), false);
});
