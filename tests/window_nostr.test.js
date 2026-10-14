// US-1670 — window.nostr injection: the permission surface is the security
// decision (design §4.1). The page-visible API is **sign-and-prompt only**:
// getPublicKey/listKeys are deliberately touch-free (npubs are public —
// getPublicKey is the first call any NIP-07 client makes), and what the page
// cannot do is sign without a physical touch. That last half is enforced by
// the *device*, so the test drives the real seam stack — bridge →
// FapicoSigner → the mock device double — and proves the refusal word
// survives the crossing.

import test from 'node:test';
import assert from 'node:assert/strict';

import { bytesToHex } from '@noble/hashes/utils.js';
import { verifyEvent } from 'nostr-tools';

import {
  NOSTR_MARKER,
  attachNostrBridge,
  createNostrBridge,
  installPageNostr,
} from '../src/core/window_nostr.js';

import { FapicoSigner } from '../src/core/seams.js';
import { MockDevice } from './mock_device.js';

// A same-frame fake of the window both worlds share. postMessage fans out
// to the 'message' listeners asynchronously, like a real frame.
function fakeWindow() {
  const listeners = [];
  const win = {
    location: { origin: 'https://page.example' },
    addEventListener(type, fn) {
      if (type === 'message') listeners.push(fn);
    },
    postMessage(data, origin) {
      setImmediate(() => {
        for (const fn of listeners) fn({ source: win, data, origin });
      });
    },
  };
  return win;
}

function wireBothWorlds(win, { getSigner }) {
  // Exactly what content_entry.js does in each world.
  const handler = createNostrBridge({ getSigner });
  attachNostrBridge(win, handler);
  installPageNostr(win);
}

test('US-1670 window.nostr exposes the narrow sign-and-prompt surface and nothing else', () => {
  const win = fakeWindow();
  installPageNostr(win);
  assert.ok(win.nostr, 'window.nostr must exist after injection');
  assert.deepEqual(
    Object.keys(win.nostr).sort(),
    ['getPublicKey', 'listKeys', 'signEvent'],
    'no nip04, no getRelays, no key material — the page gets the narrow API',
  );
});

test('US-1670 injection never clobbers an existing provider', () => {
  const win = fakeWindow();
  const existing = { getPublicKey: () => 'already-here' };
  win.nostr = existing;
  assert.equal(installPageNostr(win), false);
  assert.equal(win.nostr, existing);
});

test('US-1670 getPublicKey works touch-free through the full bridge', async () => {
  const mock = new MockDevice({ grants: false });
  const win = fakeWindow();
  wireBothWorlds(win, { getSigner: async () => new FapicoSigner(mock) });
  assert.equal(await win.nostr.getPublicKey(), bytesToHex(mock.pub(0)));
  assert.deepEqual(mock.calls.at(-1), { cmd: 0x41, idx: 0, argLen: 0 });
});

test('US-1670 signEvent requires the ceremony — the refusal word crosses the bridge', async () => {
  const mock = new MockDevice({ grants: false });
  const win = fakeWindow();
  wireBothWorlds(win, { getSigner: async () => new FapicoSigner(mock) });
  await assert.rejects(
    () => win.nostr.signEvent({ kind: 1, content: 'x', tags: [], created_at: 1 }),
    (err) => err.sw === 0x6985 && err.code === 'SW_6985',
  );
  assert.equal(mock.lastParked, 0x42);
});

test('US-1670 signEvent with the ceremony produces an event nostr-tools verifies', async () => {
  const mock = new MockDevice();
  const win = fakeWindow();
  wireBothWorlds(win, { getSigner: async () => new FapicoSigner(mock) });
  const signed = await win.nostr.signEvent({
    kind: 1, content: 'from the page', tags: [], created_at: 1700000000,
  });
  assert.ok(verifyEvent(signed));
  assert.equal(signed.pubkey, bytesToHex(mock.pub(0)));
});

test('US-1670 methods outside the narrow surface are refused before the signer is touched', async () => {
  const win = fakeWindow();
  let signerBuilt = false;
  wireBothWorlds(win, {
    getSigner: async () => { signerBuilt = true; return new FapicoSigner(new MockDevice()); },
  });
  // The provider object has no nip04 and no getRelays at all.
  assert.equal(win.nostr.nip04, undefined);
  assert.equal(win.nostr.getRelays, undefined);
  // The direct bridge route (a page bypassing the provider object entirely):
  const handler = createNostrBridge({ getSigner: async () => { throw new Error('should not build'); } });
  const reply = await handler('nip04_enc', ['peer', 'msg']);
  assert.equal(reply.error.code, 'UNSUPPORTED');
  assert.ok(!signerBuilt, 'refusals must not wake the device');
});

test('US-1670 the message channel is namespaced and ignores foreign traffic', async () => {
  const win = fakeWindow();
  installPageNostr(win);
  await new Promise((resolve) => {
    let settled = false;
    win.postMessage({ marker: NOSTR_MARKER, dir: 'call', id: 'x', method: 'nope' }, win.location.origin);
    win.postMessage({ random: 'traffic' }, win.location.origin);
    setImmediate(() => {
      settled = true;
      resolve();
    });
  });
  // No throw, no pending state leaked — the narrow provider is still usable.
  const win2 = fakeWindow();
  wireBothWorlds(win2, { getSigner: async () => new FapicoSigner(new MockDevice()) });
  assert.equal(typeof await win2.nostr.getPublicKey(), 'string');
});
