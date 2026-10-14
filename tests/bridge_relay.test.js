// US-1698 — the bridge: a stateless relay with a narrow allow-list. Page
// calls forward over the worker port; replies come back with dir:'reply'.
// A method not in the allow-list is refused loudly (forbidden-method reply
// + console.warn, and nothing touches the port); a foreign marker is
// ignored in silence; a cross-frame source is dropped; an oversized payload
// is dropped loudly.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createBridgeRelay } from '../src/content/bridge.js';
import { NOSTR_MARKER } from '../src/shared/protocol.js';

function fakeWindow() {
  const listeners = [];
  const win = {
    location: { host: 'signing.example', origin: 'https://signing.example' },
    addEventListener(type, fn) {
      if (type === 'message') listeners.push(fn);
    },
    postMessage(data, origin) {
      setImmediate(() => {
        for (const fn of listeners) fn({ source: win, data, origin });
      });
    },
    __listeners: listeners,
  };
  return win;
}

/** A scripted port double recording what the relay forwards. */
function fakePort() {
  const listeners = { message: [], disconnect: [] };
  const p = {
    sent: [],
    onMessage: { addListener: (fn) => listeners.message.push(fn) },
    onDisconnect: { addListener: (fn) => listeners.disconnect.push(fn) },
    postMessage: (m) => p.sent.push(m),
    __deliver: (m) => listeners.message.forEach((fn) => fn(m)),
    __disconnect: () => listeners.disconnect.forEach((fn) => fn()),
    __name: null,
  };
  Object.defineProperty(p, 'name', { get: () => p.__name });
  return p;
}
const port = fakePort();

function wiredRelay(win) {
  const warns = [];
  const localPort = fakePort();
  const relay = createBridgeRelay({
    win,
    connect: (name) => {
      localPort.__name = name;
      return localPort;
    },
    warn: (m) => warns.push(m),
  });
  win.addEventListener('message', relay);
  return { relay, warns, port: localPort };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, timeoutMs = 500) => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(2);
  }
  return fn();
};

test('US-1698 a page call forwards over the port and the reply crosses back', async () => {
  const win = fakeWindow();
  const { warns, port: port } = wiredRelay(win);
  const replies = [];
  win.__listeners.push((ev) => {
    const d = ev.data;
    if (d?.dir === 'reply') replies.push(d);
  });

  win.postMessage(
    { marker: NOSTR_MARKER, dir: 'call', id: 'p0', method: 'get_public_key', args: [], host: 'signing.example' },
    win.location.origin,
  );
  await waitFor(() => port.sent.length === 1);
  assert.equal(port.sent.length, 1);
  assert.deepEqual(port.sent[0], { id: 'p0', method: 'get_public_key', args: [], host: 'signing.example' });
  assert.ok(port.__name.startsWith('nostr-'), 'the port is named nostr-<seq>');

  port.__deliver({ id: 'p0', result: 'ee'.repeat(32) });
  await waitFor(() => replies.length === 1);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].dir, 'reply');
  assert.equal(replies[0].reply.result, 'ee'.repeat(32));
  assert.deepEqual(warns, []);
});

test('US-1698 a method not in the allow-list is refused loudly, and the port never sees it', async () => {
  const win = fakeWindow();
  const { warns, port: port } = wiredRelay(win);
  const replies = [];
  win.__listeners.push((ev) => {
    if (ev.data?.dir === 'reply') replies.push(ev.data);
  });

  win.postMessage(
    { marker: NOSTR_MARKER, dir: 'call', id: 'p1', method: 'generate_key', args: [0], host: 'x' },
    win.location.origin,
  );
  await waitFor(() => replies.length === 1);
  assert.equal(port.sent.length, 0, 'the port was never woken');
  assert.equal(replies[0].reply.error.code, 'forbidden-method');
  assert.equal(warns.length, 1, 'the refusal is loud on the console too');
});

test('US-1698 a foreign marker is ignored in silence', async () => {
  const win = fakeWindow();
  const { warns, port: port } = wiredRelay(win);
  win.postMessage({ marker: 'other-extension:1', dir: 'call', id: 'p2', method: 'sign_event', args: [] }, win.location.origin);
  win.postMessage({ random: 'traffic' }, win.location.origin);
  await sleep(10);
  assert.equal(port.sent.length, 0);
  assert.deepEqual(warns, [], 'silence for foreign markers — no console noise');
});

test('US-1698 a cross-frame source is dropped (the same-frame guard)', async () => {
  const win = fakeWindow();
  const relay = createBridgeRelay({ win, connect: () => fakePort() });
  // An event whose source is another frame (an iframe, another window).
  relay({ source: { other: true }, data: { marker: NOSTR_MARKER, dir: 'call', id: 'p3', method: 'sign_event', args: [] } });
  await sleep(10);
  assert.equal(port.sent.length, 0);
});

test('US-1698 an oversized payload is dropped loudly, with a typed reply', async () => {
  const win = fakeWindow();
  const { warns, port: port } = wiredRelay(win);
  const replies = [];
  win.__listeners.push((ev) => {
    if (ev.data?.dir === 'reply') replies.push(ev.data);
  });
  const big = 'x'.repeat((1 << 20) + 100);
  win.postMessage(
    { marker: NOSTR_MARKER, dir: 'call', id: 'p4', method: 'nip44_encrypt', args: ['cc'.repeat(32), big], host: 'x' },
    win.location.origin,
  );
  await waitFor(() => replies.length === 1);
  assert.equal(port.sent.length, 0);
  assert.equal(replies[0].reply.error.code, 'payload-too-large');
  assert.equal(warns.length, 1);
});

test('US-1698 the port reconnects on worker restart — the next call reopens it', async () => {
  const win = fakeWindow();
  let opens = 0;
  const ports = [];
  const warns = [];
  const relay = createBridgeRelay({
    win,
    connect: (name) => {
      opens++;
      const p = fakePort();
      p.__name = name;
      ports.push(p);
      return p;
    },
    warn: (m) => warns.push(m),
  });
  win.addEventListener('message', relay);

  win.postMessage({ marker: NOSTR_MARKER, dir: 'call', id: 'p5', method: 'list_keys', args: [] }, win.location.origin);
  await sleep(2);
  assert.equal(opens, 1);
  ports[0].__disconnect(); // the worker died
  win.postMessage({ marker: NOSTR_MARKER, dir: 'call', id: 'p6', method: 'list_keys', args: [] }, win.location.origin);
  await sleep(2);
  assert.equal(opens, 2, 'the next call reopened the port');
  assert.equal(ports[1].__name, ports[0].__name, 'the same name — US-1695 re-delivery rides it');
});
