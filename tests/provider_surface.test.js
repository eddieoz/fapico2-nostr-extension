// US-1697 — the window.nostr surface: the NIP-07 trio plus nip44. A call
// posts {marker, dir:'call', id, method, args, host} and parks a promise;
// dir:'reply' resolves or rejects it; a typed error's name survives the
// postMessage boundary; the surface is exactly the five methods; an
// existing provider is never clobbered.

import test from 'node:test';
import assert from 'node:assert/strict';

import { installProvider } from '../src/provider/provider.js';
import { NOSTR_MARKER } from '../src/shared/protocol.js';

// A same-frame fake of the window both worlds share (the ported
// window_nostr.test.js pattern).
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

/** Wire the provider to a scripted relay half (stand-in for bridge+worker):
 *  answers each call frame through the same window, like the bridge does. */
function wireResponder(win, respond) {
  win.__listeners.push((ev) => {
    const d = ev.data;
    if (!d || d.marker !== NOSTR_MARKER || d.dir !== 'call') return;
    setImmediate(() => {
      const reply = respond(d);
      win.postMessage(
        { marker: NOSTR_MARKER, dir: 'reply', id: d.id, reply },
        win.location.origin,
      );
    });
  });
}

test('US-1697 the surface is exactly the NIP-07 trio plus nip44', () => {
  const win = fakeWindow();
  assert.equal(installProvider(win), true);
  assert.deepEqual(Object.keys(win.nostr).sort(), ['getPublicKey', 'listKeys', 'nip44', 'signEvent']);
  assert.deepEqual(Object.keys(win.nostr.nip44).sort(), ['decrypt', 'encrypt']);
  // No nip04, no getRelays, no key material — the page gets the narrow API.
  assert.equal(win.nostr.nip04, undefined);
  assert.equal(win.nostr.getRelays, undefined);
});

test('US-1697 injection never clobbers an existing provider', () => {
  const win = fakeWindow();
  const existing = { getPublicKey: () => 'already-here' };
  win.nostr = existing;
  assert.equal(installProvider(win), false);
  assert.equal(win.nostr, existing);
});

test('US-1697 every call attaches the host — the prompt window renders it', async () => {
  const win = fakeWindow();
  const seen = [];
  wireResponder(win, (d) => {
    seen.push(d);
    return { result: 'aa'.repeat(32) };
  });
  installProvider(win);
  await win.nostr.getPublicKey();
  await win.nostr.nip44.encrypt('bb'.repeat(32), 'hello');
  assert.equal(seen[0].host, 'signing.example');
  assert.equal(seen[1].host, 'signing.example');
  assert.equal(seen[0].dir, 'call');
  assert.equal(seen[0].marker, NOSTR_MARKER);
  assert.equal(seen[0].method, 'get_public_key');
});

test('US-1697 signEvent sends the event as the page provided — the worker hashes', async () => {
  const win = fakeWindow();
  const seen = [];
  wireResponder(win, (d) => {
    seen.push(d);
    return { result: { id: 'x', sig: 'y' } };
  });
  installProvider(win);
  const event = { kind: 1, content: 'hi', tags: [], created_at: 7 };
  const out = await win.nostr.signEvent(event);
  assert.deepEqual(seen[0].args, [event], 'the event crosses untouched (no sighash computed in the page)');
  assert.deepEqual(out, { id: 'x', sig: 'y' });
});

test('US-1697 nip44.encrypt passes utf8 hex; nip44.decrypt returns the plaintext string', async () => {
  const win = fakeWindow();
  wireResponder(win, (d) => {
    if (d.method === 'nip44_encrypt') {
      assert.equal(d.args[0], 'bb'.repeat(32));
      // 'hello' in hex.
      assert.equal(d.args[1], '68656c6c6f');
      return { result: 'cafe'.repeat(4) };
    }
    if (d.method === 'nip44_decrypt') {
      assert.equal(d.args[1], 'aabbccdd');
      // The worker returns the plaintext as a byte-array (the device's raw
      // answer, spread for JSON) — 'fine' as bytes, not a hex string.
      return { result: [0x66, 0x69, 0x6e, 0x65] };
    }
    return { error: { name: 'UnsupportedMethodError', code: 'unsupported-method', message: 'x' } };
  });
  installProvider(win);
  const payload = await win.nostr.nip44.encrypt('bb'.repeat(32), 'hello');
  assert.equal(payload, 'cafecafecafecafe', 'the raw payload crosses as the device produced it');
  const pt = await win.nostr.nip44.decrypt('cc'.repeat(32), 'aabbccdd');
  assert.equal(pt, 'fine');
});

test('US-1697 a reply naming an error rejects with the typed error revived (name preserved)', async () => {
  const win = fakeWindow();
  wireResponder(win, (d) => ({
    error: {
      name: 'DeviceAbsentError',
      code: 'DEVICE_ABSENT',
      message: 'no Fapico board connected — connect it and try again',
      device: 'Fapico board',
    },
  }));
  installProvider(win);
  await assert.rejects(
    () => win.nostr.getPublicKey(),
    (err) => {
      assert.equal(err.name, 'DeviceAbsentError', 'the name survives the postMessage boundary');
      assert.equal(err.code, 'DEVICE_ABSENT');
      assert.equal(err.message, 'no Fapico board connected — connect it and try again');
      return true;
    },
  );
});

test('US-1697 foreign and stale replies are ignored; ids do not cross-resolve', async () => {
  const win = fakeWindow();
  installProvider(win);
  // Traffic that is not ours: no throw, no pending state leak.
  win.postMessage({ marker: NOSTR_MARKER, dir: 'call', id: 'p999', method: 'nope', args: [] }, win.location.origin);
  win.postMessage({ random: 'traffic' }, win.location.origin);
  win.postMessage({ marker: NOSTR_MARKER, dir: 'reply', id: 'p404', reply: { result: 'ghost' } }, win.location.origin);
  await new Promise((r) => setTimeout(r, 5));
  // The provider is still usable: a real round trip resolves.
  wireResponder(win, () => ({ result: 'ok' }));
  assert.equal(await win.nostr.listKeys(), 'ok');
});
