// US-1748 — the provider's call id is unguessable. The id stops being a
// predictable counter (p0, p1, …) and becomes a v4 UUID built from
// crypto.getRandomValues (available in every context, unlike randomUUID which
// is secure-context-only under an <all_urls> manifest). A reply naming an id
// the provider does not currently have pending is ignored (the existing
// `if (!p) return` guard), which is what makes an unguessable id load-bearing:
// the page can no longer pre-forge a reply for a call it has not observed.

import test from 'node:test';
import assert from 'node:assert/strict';

import { installProvider } from '../src/provider/provider.js';
import { NOSTR_MARKER } from '../src/shared/protocol.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function fakeWindow() {
  const listeners = [];
  const win = {
    location: { host: 'id.example', origin: 'https://id.example' },
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

test('US-1748 the call id is a v4 UUID, not the predictable p0 counter', async () => {
  const win = fakeWindow();
  const calls = [];
  win.__listeners.push((ev) => {
    const d = ev.data;
    if (d && d.marker === NOSTR_MARKER && d.dir === 'call') calls.push(d);
  });
  installProvider(win);
  // Fire without awaiting: no responder settles the parked promise, and the
  // call frame is posted synchronously — the capture listener sees it on the
  // next tick.
  win.nostr.getPublicKey();
  win.nostr.listKeys();
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.length, 2, 'two calls were posted');
  for (const c of calls) {
    assert.match(c.id, UUID_RE, `the id ${c.id} is a v4 UUID`);
    assert.notEqual(c.id, 'p0', 'not the old predictable counter');
  }
  assert.notEqual(calls[0].id, calls[1].id, 'each call gets a distinct id');
});

test('US-1748 a reply naming a non-pending id is ignored (the guard that makes the UUID load-bearing)', async () => {
  const win = fakeWindow();
  installProvider(win);
  // Forge a reply for an id the provider never parked: no throw, no settle.
  win.postMessage(
    { marker: NOSTR_MARKER, dir: 'reply', id: '00000000-0000-4000-8000-000000000000', reply: { result: 'ghost' } },
    win.location.origin,
  );
  await new Promise((r) => setTimeout(r, 5));
  // The provider is still usable: a real round trip resolves.
  win.__listeners.push((ev) => {
    const d = ev.data;
    if (d && d.marker === NOSTR_MARKER && d.dir === 'call') {
      setImmediate(() =>
        win.postMessage({ marker: NOSTR_MARKER, dir: 'reply', id: d.id, reply: { result: 'ok' } }, win.location.origin),
      );
    }
  });
  assert.equal(await win.nostr.getPublicKey(), 'ok');
});
