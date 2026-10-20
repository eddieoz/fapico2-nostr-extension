// US-1749 — replies flow over a MessageChannel port the page never receives.
// The provider and the page share the window's postMessage channel, so a
// page-forged {marker, dir:'reply', id} settles a call today. The bridge hands
// the provider a dedicated MessageChannel.port2 through a one-time handshake
// the provider claims at install; every reply the bridge produces is delivered
// over that port, and the provider's reply listener reads ONLY the port — a
// page-forged window reply is ignored. (Honest limit, R-4: a page listener
// registered before the handshake also receives port2 and can forge to it; the
// protection is that a passive page never gets the port.)

import test from 'node:test';
import assert from 'node:assert/strict';

import { installProvider } from '../src/provider/provider.js';
import { NOSTR_MARKER } from '../src/shared/protocol.js';

function fakeWindow() {
  const listeners = [];
  const win = {
    location: { host: 'port.example', origin: 'https://port.example' },
    addEventListener(type, fn) {
      if (type === 'message') listeners.push(fn);
    },
    postMessage(data, origin, transfer) {
      setImmediate(() => {
        for (const fn of listeners) fn({ source: win, data, origin });
      });
    },
    __listeners: listeners,
  };
  return win;
}

// A fake bridge: answer the provider's one-time init with the handshake
// (transferring port2), and deliver each call's reply over port1 — which the
// provider reads on port2. Also forge a window reply with a different value so
// the test proves the port value wins.
function wireFakeBridge(win, channel) {
  win.__listeners.push((ev) => {
    const d = ev.data;
    if (!d || d.marker !== NOSTR_MARKER) return;
    if (d.dir === 'init') {
      setImmediate(() =>
        win.postMessage(
          { marker: NOSTR_MARKER, dir: 'handshake', port: channel.port2 },
          win.location.origin,
          [channel.port2],
        ),
      );
    } else if (d.dir === 'call') {
      setImmediate(() => {
        win.postMessage(
          { marker: NOSTR_MARKER, dir: 'reply', id: d.id, reply: { result: 'forged' } },
          win.location.origin,
        );
        channel.port1.postMessage({ id: d.id, reply: { result: 'real' } });
      });
    }
  });
}

test('US-1749 a call settles with the port-delivered result; a forged window reply is ignored', async () => {
  const win = fakeWindow();
  const channel = new MessageChannel();
  wireFakeBridge(win, channel);
  installProvider(win);
  await new Promise((r) => setTimeout(r, 10)); // let the handshake claim port2
  const result = await win.nostr.getPublicKey();
  assert.equal(result, 'real', 'the port reply settles; the forged window reply is ignored');
  channel.port1.close();
  channel.port2.close(); // frees the event loop — open ports keep Node alive
});

test('US-1749 with no handshake (no bridge), a forged window reply cannot settle the call', async () => {
  const win = fakeWindow();
  let callId = null;
  win.__listeners.push((ev) => {
    const d = ev.data;
    if (d && d.marker === NOSTR_MARKER && d.dir === 'call') callId = d.id;
  });
  installProvider(win); // no bridge: no handshake, port2 never claimed
  await new Promise((r) => setTimeout(r, 10));
  const call = win.nostr.getPublicKey();
  await new Promise((r) => setImmediate(r)); // let the call frame post
  win.postMessage(
    { marker: NOSTR_MARKER, dir: 'reply', id: callId, reply: { result: 'forged' } },
    win.location.origin,
  );
  await new Promise((r) => setTimeout(r, 10));
  const state = await Promise.race([
    call.then(
      () => 'settled',
      () => 'settled',
    ),
    new Promise((r) => setTimeout(() => r('pending'), 10)),
  ]);
  assert.equal(state, 'pending', 'no port claimed means a window forgery cannot settle the call');
});

test('US-1749 even a page that claimed port2 during the handshake cannot forge a reply — injection requires port1', async () => {
  const win = fakeWindow();
  const channel = new MessageChannel();
  let pagePort = null;
  // The page's listener: registered before the handshake dispatches, it
  // receives the handshake event (a postMessage transfer is a broadcast to
  // every MAIN-world listener) and grabs port2 — R-4's honest limit. But a
  // MessagePort only receives what the OTHER end posts: injecting into
  // port2's queue requires port1, which the bridge keeps. The page holding
  // port2 can eavesdrop on replies, not forge them — its forgery attempt
  // lands on port1 (the bridge's end), which never reads it.
  win.__listeners.push((ev) => {
    const d = ev.data;
    if (!d || d.marker !== NOSTR_MARKER) return;
    if (d.dir === 'handshake' && d.port) {
      pagePort = d.port;
    } else if (d.dir === 'call' && pagePort) {
      setImmediate(() => pagePort.postMessage({ id: d.id, reply: { result: 'forged' } }));
    }
  });
  // The bridge answers init with the handshake and delivers the real reply
  // over port1 — the only way into port2's queue.
  win.__listeners.push((ev) => {
    const d = ev.data;
    if (!d || d.marker !== NOSTR_MARKER) return;
    if (d.dir === 'init') {
      setImmediate(() =>
        win.postMessage(
          { marker: NOSTR_MARKER, dir: 'handshake', port: channel.port2 },
          win.location.origin,
          [channel.port2],
        ),
      );
    } else if (d.dir === 'call') {
      setImmediate(() => channel.port1.postMessage({ id: d.id, reply: { result: 'real' } }));
    }
  });
  installProvider(win);
  await new Promise((r) => setTimeout(r, 10));
  const result = await win.nostr.getPublicKey();
  assert.equal(result, 'real', 'a page holding port2 cannot inject into its queue — the reply is the bridge’s');
  channel.port1.close();
  channel.port2.close();
});
