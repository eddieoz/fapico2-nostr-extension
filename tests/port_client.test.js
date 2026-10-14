// US-1721 — the port client now forwards worker push frames ({event, ...}, no
// id) to onEvent listeners and surfaces a disconnected port via onDisconnect,
// without touching the id-matched reply routing (US-1692). No real chrome.port
// in Node, so the port is a tiny in-memory double: postMessage records the
// page→worker frames, and the test drives worker→page messages/disconnect
// through the recorded listeners directly.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createPortClient } from '../src/shared/port-client.js';

function rig({ heartbeatMs } = {}) {
  const ports = [];
  let connectThrows = false;
  let killNextPorts = 0;
  const makePort = (name) => {
    const listeners = { message: [], disconnect: [] };
    const port = {
      name,
      postMessage: (msg) => {
        if (port.dead) throw new Error('Attempting to use a disconnected port object');
        port.sent.push(msg);
      },
      sent: [],
      dead: killNextPorts > 0 && (killNextPorts -= 1) >= 0,
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
      onDisconnect: { addListener: (fn) => listeners.disconnect.push(fn) },
      __listeners: listeners,
    };
    return port;
  };
  const chrome_ = {
    runtime: {
      connect: ({ name }) => {
        if (connectThrows) throw new Error('Extension context invalidated');
        const p = makePort(name);
        ports.push(p);
        return p;
      },
    },
  };
  const clock = { v: 1000000 };
  // heartbeatMs defaults to 0 in tests: a repeating interval would hold the
  // event loop open forever; only the heartbeat test opts in.
  const client = createPortClient({ chrome_, name: 'nostr-test', now: () => clock.v, heartbeatMs: heartbeatMs ?? 0, ...(heartbeatMs ? {} : {}) });
  const last = () => ports[ports.length - 1];
  return {
    client,
    ports,
    last,
    setConnectThrows: () => { connectThrows = true; },
    killNextPorts: (n) => { killNextPorts = n; },
    clock,
    // a frame the worker would postMessage to the page
    push(msg) { for (const fn of last().__listeners.message) fn(msg); },
    // a framed reply (has an id) the worker would postMessage to the page
    reply(msg) { for (const fn of last().__listeners.message) fn(msg); },
    disconnect() { for (const fn of last().__listeners.disconnect) fn(); },
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

// US-1741 — the board run: the worker idles out (~30 s) while a human sits at
// the chooser; the page's next call posted into a DEAD port and Chrome's
// internal "Attempting to use a disconnected port object" leaked into the
// page. The client now heals like the bridge does: a disconnected port is
// replaced lazily, under the SAME name (re-delivery and the prompt binding
// ride the name), with the listeners re-attached; a send that still fails
// rejects typed — never Chrome's internal string.

test('US-1741 a call after a worker restart reconnects under the same name and still resolves', async () => {
  const r = rig();
  const p1 = r.ports[0];
  r.disconnect(); // the worker restarted: port A is dead
  const promise = r.client.call('get_active_slot');
  const p2 = r.last();
  assert.ok(p2 !== p1, 'a NEW port was created');
  assert.equal(p2.name, p1.name, 'the reconnect rides the SAME port name');
  assert.deepEqual(p2.sent, [{ id: 'c0', method: 'get_active_slot', args: [] }], 'the frame went to the new port');
  r.reply({ id: 'c0', result: { slot: 2 } });
  assert.deepEqual(await promise, { slot: 2 });
});

test('US-1741 the reconnected port carries the listeners — pushes and disconnects still flow', async () => {
  const r = rig();
  const seen = [];
  r.client.onEvent((frame) => seen.push(frame));
  let disconnects = 0;
  r.client.onDisconnect(() => { disconnects += 1; });
  r.disconnect();      // worker restart #1
  r.push({ event: 'prompt-settled', requestId: 'r1' }); // via the NEW port
  assert.deepEqual(seen, [{ event: 'prompt-settled', requestId: 'r1' }], 'onEvent was re-attached to the new port');
  r.disconnect();      // worker restart #2 (the new port's disconnect listeners)
  assert.equal(disconnects, 2, 'onDisconnect was re-attached to the new port');
});

test('US-1741 a post that still throws rejects typed — never Chrome\'s internal string', async () => {
  const r = rig();
  r.disconnect();
  r.killNextPorts(2); // the reconnect AND its retry land on dead ports
  const err = await r.client.call('revoke_all').then(() => null, (e) => e);
  assert.equal(err.code, 'transport-lost');
  assert.equal(err.name, 'TransportError');
  assert.equal(err.message, 'the connection to the extension was lost — try again');
  assert.notEqual(err.message, 'Attempting to use a disconnected port object');
});

test('US-1741 a runtime.connect failure after the restart rejects typed', async () => {
  const r = rig();
  r.disconnect();
  r.setConnectThrows(); // the extension context itself is gone
  const err = await r.client.call('get_grants').then(() => null, (e) => e);
  assert.equal(err.code, 'transport-lost');
  assert.equal(err.name, 'TransportError');
});

// US-1744 — the board run, take two: Chrome does NOT reliably deliver
// port.onDisconnect when the MV3 worker is killed by idleness — the page's
// port object stays "connected" and postMessage silently black-holes (the
// monitor saw the worker start ZERO times while a connect attempt hung).
// The client tracks its last inbound frame; a call after the staleness
// window abandons the silent port and reconnects BEFORE sending.

test('US-1744 a call after a silent window abandons the stale port and reconnects first', async () => {
  const r = rig();
  const p1 = r.ports[0];
  const first = r.client.call('echo');
  r.reply({ id: 'c0', result: { ok: true } }); // inbound activity: lastSeen = now
  await first;
  r.clock.v += 30000; // 30s of silence — the worker idled out
  const promise = r.client.call('get_active_slot');
  const p2 = r.last();
  assert.ok(p2 !== p1, 'the stale port was abandoned, a fresh one connected');
  assert.equal(p2.name, 'nostr-test', 'the fresh port rides the same name');
  assert.deepEqual(p2.sent, [{ id: 'c1', method: 'get_active_slot', args: [] }]);
  r.reply({ id: 'c1', result: { slot: 0 } });
  assert.deepEqual(await promise, { slot: 0 });
});

test('US-1744 a call inside the staleness window reuses the live port', async () => {
  const r = rig();
  const p1 = r.ports[0];
  const first = r.client.call('echo');
  r.reply({ id: 'c0', result: { ok: true } });
  await first;
  r.clock.v += 5000; // 5s — inside the window
  const promise = r.client.call('get_active_slot');
  assert.equal(r.last(), p1, 'no reconnect while the port is fresh');
  r.reply({ id: 'c1', result: { slot: 0 } });
  assert.deepEqual(await promise, { slot: 0 });
});

test('US-1744 a late disconnect from an abandoned port does not null the fresh one', async () => {
  const r = rig();
  const first = r.client.call('echo');
  r.reply({ id: 'c0', result: { ok: true } });
  await first;
  r.clock.v += 30000;
  const promise = r.client.call('get_active_slot');
  const p2 = r.last();
  r.disconnect(); // the ABANDONED port's disconnect lands late
  assert.equal(r.last(), p2, 'the fresh port survives the stale port\'s late disconnect');
  r.reply({ id: 'c1', result: { slot: 0 } });
  assert.deepEqual(await promise, { slot: 0 });
});

// US-1744 take two — the worker idling out mid-flow is the ROOT of the whole
// board-run bug family: mid-op death loses calls and leaks the open device
// handle ("The device is already open" until a browser restart). Extension
// pages therefore heartbeat the worker while they are open (echo every 20 s
// — the SW never idles during an active session; when the page closes, the
// heartbeat stops and the worker idles normally). The bridge is not this
// client, so web tabs never keep the worker alive.
test('US-1745 the client heartbeats the worker while the page is open — the worker never idles mid-flow', async () => {
  const r = rig({ heartbeatMs: 5 });
  await new Promise((resolve) => setTimeout(resolve, 120));
  r.client.dispose();
  const beats = r.ports[0].sent.filter((f) => f.method === 'echo');
  assert.ok(beats.length >= 2, `echo frames flow while the page is open (got ${beats.length})`);
});

