// US-1692 — the port-based messaging spine: {id, method, args} frames route
// to a data method table, answered {id, result} or {id, error: {name,
// message, code?}}; anything outside the table is `unsupported-method`; the
// sender gate refuses management methods from relayed (tab) senders with
// `forbidden-method`.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PAGE_ALLOWED_METHODS,
  TRUSTED_ONLY_METHODS,
  createDispatch,
  isTrustedExtensionSender,
} from '../src/worker/dispatch.js';

const EXT_ID = 'test-extension-id';
const trustedSender = { url: `chrome-extension://${EXT_ID}/popup.html` };
const tabSender = { url: 'https://signing.example/post.html' };

function testDispatch(extra = {}) {
  const calls = [];
  return {
    calls,
    dispatch: createDispatch(
      {
        echo: async (args) => ({ echoed: args }),
        get_public_key: async () => {
          calls.push('get_public_key');
          return 'aa'.repeat(32);
        },
        sign_event: async () => {
          calls.push('sign_event');
          return { sig: 'ff' };
        },
        list_keys: async () => [],
        nip44_encrypt: async () => new Uint8Array(65),
        nip44_decrypt: async () => new Uint8Array(4),
        generate_key: async () => {
          calls.push('generate_key');
          return { npub: 'bb'.repeat(32) };
        },
        ...extra,
      },
      { extensionId: EXT_ID },
    ),
  };
}

test('US-1692 the echo canary answers a trusted extension-page sender', async () => {
  const { dispatch } = testDispatch();
  const reply = await dispatch({ id: 1, method: 'echo', args: ['hi'] }, trustedSender);
  assert.deepEqual(reply, { id: 1, result: { echoed: ['hi'] } });
});

test('US-1692 an unknown method is rejected unsupported-method, never a silent no-op', async () => {
  const { dispatch } = testDispatch();
  // export_key was retired with the export feature (US-1699) — it rides the
  // unsupported-method path now, which is itself a useful probe.
  const reply = await dispatch({ id: 2, method: 'no_such_verb', args: [] }, trustedSender);
  assert.equal(reply.id, 2);
  assert.equal(reply.error.code, 'unsupported-method');
  assert.equal(reply.error.name, 'UnsupportedMethodError');
  assert.ok(reply.error.message.length > 0);
});

test('US-1692 the retired export_key verb is unsupported-method, not a silent pass-through', async () => {
  const { dispatch } = testDispatch();
  const reply = await dispatch({ id: 2, method: 'export_key', args: [] }, trustedSender);
  assert.equal(reply.error.code, 'unsupported-method', 'the removal did not leave a dispatchable stub');
});

test('US-1692 a page-allowed method called from an extension-page sender still works', async () => {
  const { dispatch, calls } = testDispatch();
  const reply = await dispatch({ id: 3, method: 'sign_event', args: [] }, trustedSender);
  assert.deepEqual(reply, { id: 3, result: { sig: 'ff' } });
  assert.deepEqual(calls, ['sign_event']);
});

test('US-1692 a management method called from a relayed (tab) sender is rejected forbidden-method', async () => {
  const { dispatch, calls } = testDispatch();
  const reply = await dispatch({ id: 4, method: 'generate_key', args: [] }, tabSender);
  assert.equal(reply.error.code, 'forbidden-method');
  assert.equal(calls.length, 0, 'the handler never ran');
});

test('US-1692 the five page-allowed methods are exactly the relayed set', () => {
  assert.deepEqual(
    [...PAGE_ALLOWED_METHODS].sort(),
    ['get_public_key', 'list_keys', 'nip44_decrypt', 'nip44_encrypt', 'sign_event'],
  );
  // And no page-allowed name is also a trusted-only name: the sets are disjoint.
  for (const m of PAGE_ALLOWED_METHODS) {
    assert.ok(!TRUSTED_ONLY_METHODS.has(m), `${m} cannot be in both sets`);
  }
});

test('US-1692 the sender gate is the chrome-extension URL check on this runtime id', () => {
  assert.ok(isTrustedExtensionSender(trustedSender, EXT_ID));
  assert.ok(!isTrustedExtensionSender(tabSender, EXT_ID));
  // A hostile sender spoofing a foreign extension id is not trusted.
  assert.ok(!isTrustedExtensionSender({ url: 'chrome-extension://other/popup.html' }, EXT_ID));
  assert.ok(!isTrustedExtensionSender(null, EXT_ID));
  assert.ok(!isTrustedExtensionSender({ url: 'chrome-extension://test-extension-id' }, EXT_ID),
    'the trailing slash is part of the pattern');
});

test('US-1692 a handler throw is a typed error reply, never a hang', async () => {
  const { dispatch } = testDispatch({
    list_keys: async () => {
      throw Object.assign(new Error('no device'), { name: 'DeviceAbsentError', code: 'DEVICE_ABSENT' });
    },
  });
  const reply = await dispatch({ id: 5, method: 'list_keys', args: [] }, tabSender);
  assert.equal(reply.error.code, 'DEVICE_ABSENT');
  assert.equal(reply.error.name, 'DeviceAbsentError');
});

test('US-1692 a frame without an id or method is ignored (null reply)', async () => {
  const { dispatch } = testDispatch();
  assert.equal(await dispatch(null, trustedSender), null);
  assert.equal(await dispatch({ id: 6 }, trustedSender), null);
  assert.equal(await dispatch({ method: 'echo' }, trustedSender), null);
});

// US-1710 — the documented closure invariant, now enforced: every method in
// the real handler table is registered in exactly one of the two sets, and
// the active-slot handlers are trusted-only (a tab sender is refused before
// the handler runs).
import { createDeviceOwner } from '../src/worker/device.js';
import { createHandlers } from '../src/worker/handlers.js';

test('US-1710 the real handler table is closed over PAGE_ALLOWED ∪ TRUSTED_ONLY', async () => {
  const device = createDeviceOwner({ getGrantedDevice: async () => null });
  const handlers = createHandlers({ device });
  for (const name of Object.keys(handlers)) {
    assert.ok(
      PAGE_ALLOWED_METHODS.has(name) || TRUSTED_ONLY_METHODS.has(name),
      `${name} is in the table but in neither method set`,
    );
  }
  assert.ok(TRUSTED_ONLY_METHODS.has('get_active_slot'));
  assert.ok(TRUSTED_ONLY_METHODS.has('set_active_slot'));
});

test('US-1710 set_active_slot from a tab sender is forbidden-method; the handler never ran', async () => {
  const ran = [];
  const { dispatch } = testDispatch({
    set_active_slot: async () => {
      ran.push('set_active_slot');
      return {};
    },
  });
  const reply = await dispatch({ id: 7, method: 'set_active_slot', args: [2] }, tabSender);
  assert.equal(reply.error.code, 'forbidden-method');
  assert.equal(ran.length, 0, 'the handler never ran');
});

// US-1746 — unpair_device is NOT in the table: HIDDevice.forget() bricks
// re-pairing when the firmware's vendor interface is hidden by the picker
// (board-run finding, CRITICAL). The owner keeps unpair() for a future
// design that can guarantee re-grantability.
test('US-1746 unpair_device is not a dispatch method — the forget grant-revoke is UI-poison', async () => {
  const { TRUSTED_ONLY_METHODS, PAGE_ALLOWED_METHODS } = await import('../src/worker/dispatch.js');
  assert.ok(!TRUSTED_ONLY_METHODS.has('unpair_device'), 'unpair_device is not dispatchable');
  assert.ok(!PAGE_ALLOWED_METHODS.has('unpair_device'));
});
