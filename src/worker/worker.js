// The MV3 service worker — the device owner. Boot order (US-1695):
// widen storage.session's access level (the write-block fix), re-adopt the
// persisted pending-request map, then serve ports. One device, one
// transaction at a time; the queue waits, it never refuses.
import { createDispatch, attachPortListener } from './dispatch.js';
import { createDeviceOwner, findGrantedDevice } from './device.js';
import { createPendingStore } from './session.js';
import { createHandlers } from './handlers.js';
import { createPermissionStore } from './permissions.js';
import { createPromptFlow, buildPreview } from './prompt.js';
import { createConsentGate, hostFromSender } from './consent.js';
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
  await pending.adopt();

  const permissions = createPermissionStore({ storage: chrome_.storage.local });
  const prompt = createPromptFlow({ windows: chrome_.windows });
  const consent = createConsentGate({
    permissions,
    prompt,
    pending,
    portName: () => 'nostr-consent',
    hostOf: hostFromSender,
    previewOf: buildPreview,
  });

  const handlers = createHandlers({
    device,
    consent,
    previewOf: buildPreview,
    listGrants: () => permissions.list(),
    revoke: (host) => permissions.revoke(host),
    onPromptDecision: async ([decision]) => prompt.decide(decision ?? {}),
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

  return { pending, device, route, permissions, prompt };
}

// Boot. The guard keeps the module importable in tests without a chrome API.
if (typeof chrome !== 'undefined' && chrome.runtime?.onConnect) {
  bootWorker().catch((err) => {
    console.error('fapico2 nostr worker boot failed', err);
  });
}
