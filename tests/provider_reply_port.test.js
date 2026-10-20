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

test('US-1749 the honest limit (R-4): a page listener that claimed port2 during the handshake can still forge', async () => {
  const win = fakeWindow();
  const channel = new MessageChannel();
  let pagePort = null;
  // The page's listener: registered before the handshake dispatches, it
  // receives the handshake event (a postMessage transfer is a broadcast to
  // every MAIN-world listener, not a consumption) and grabs port2. This is
  // the accepted threat model, R-4: the protection is that a PASSIVE page
  // never receives the port — not that an active page cannot claim it.
  win.__listeners.push((ev) => {
    const d = ev.data;
    if (!d || d.marker !== NOSTR_MARKER) return;
    if (d.dir === 'handshake' && d.port) {
      pagePort = d.port;
    } else if (d.dir === 'call' && pagePort) {
      setImmediate(() => pagePort.postMessage({ id: d.id, reply: { result: 'forged' } }));
    }
  });
  // The bridge answers init with the handshake and never replies itself —
  // only the forged port reply arrives.
  win.__listeners.push((ev) => {
    const d = ev.data;
    if (d && d.marker === NOSTR_MARKER && d.dir === 'init') {
      setImmediate(() =>
        win.postMessage(
          { marker: NOSTR_MARKER, dir: 'handshake', port: channel.port2 },
          win.location.origin,
          [channel.port2],
        ),
      );
    }
  });
  installProvider(win);
  await new Promise((r) => setTimeout(r, 10));
  const result = await win.nostr.getPublicKey();
  assert.equal(result, 'forged', 'an active page that claimed port2 forged the reply — the documented limit');
  channel.port1.close();
  channel.port2.close();
});
