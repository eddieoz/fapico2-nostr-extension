// The MV3 service worker — the device owner. Boot order (US-1695):
// widen storage.session's access level (the write-block fix), re-adopt the
// persisted pending-request map, then serve ports. One device, one
// transaction at a time; the queue waits, it never refuses.
import { createDispatch, attachPortListener } from './dispatch.js';
import { createDeviceOwner, findGrantedDevice } from './device.js';
import { createPendingStore } from './session.js';
import { createHandlers } from './handlers.js';
import { widenSessionAccess } from './worker_boot.js';

export async function bootWorker({
  chrome_ = chrome,
  navigator_ = navigator,
  device = createDeviceOwner({ getGrantedDevice: findGrantedDevice(navigator_) }),
  windowExists = (windowId) =>
    chrome_.windows
      ? chrome_.windows
          .getAll({ windowTypes: ['popup'] })
          .then((ws) => ws.some((w) => w.id === windowId))
          .catch(() => false)
      : Promise.resolve(false),
} = {}) {
  await widenSessionAccess(chrome_);
  const pending = createPendingStore({ storage: chrome_.storage.session, windowExists });
  await pending.load();
  const interrupted = await pending.adopt();

  const handlers = createHandlers({
    device,
    // Phase 4 (US-1699/1700) replaces these with the permission store and
    // the prompt orchestration; until then a relayed request is refused
    // loud rather than silently allowed.
    consent: async ({ method, sender }) => {
      throw Object.assign(new Error(`no persisted grant and no prompt yet — ${method} refused`), {
        name: 'PermissionRequiredError',
        code: 'permission-required',
      });
    },
    listGrants: async () => [],
    revoke: async () => {},
    onPromptDecision: async ([decision]) => {
      const record = pending.get(decision.id);
      if (!record) return { delivered: false };
      await pending.settle(decision.id, decision.outcome);
      return { delivered: true };
    },
  });
  const route = createDispatch(handlers);

  chrome_.runtime.onConnect.addListener((port) => {
    attachPortListener(port, route);
    // Re-delivery: a bridge reconnecting under the same port name after a
    // worker restart picks up the outstanding reply or typed error.
    pending
      .takeForPort(port.name)
      .then((replies) => {
        for (const reply of replies) port.postMessage(reply);
      })
      .catch(() => {});
    port.onDisconnect.addListener(() => device.dropQueued(port.name));
  });

  return { pending, device, route, interrupted };
}

// Boot. The guard keeps the module importable in tests without a chrome API.
if (typeof chrome !== 'undefined' && chrome.runtime?.onConnect) {
  bootWorker().catch((err) => {
    console.error('fapico2 nostr worker boot failed', err);
  });
}
