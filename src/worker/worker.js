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
import { createActiveSlotStore } from './active-slot.js';
import { DeviceAbsentError } from '../core/loudness.js';
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
  // US-1723 — the prompt port's name is `nostr-prompt-<requestId>`, so this map
  // binds a connected prompt port back to its request. Resolved from the port
  // name on connect (no new persisted field); settle() uses it to push the
  // outcome frame to exactly that window.
  const requestPorts = new Map();
  const deliver = (requestId, frame) => {
    const port = requestPorts.get(requestId);
    if (port) port.postMessage(frame);
  };
  const prompt = createPromptFlow({ windows: chrome_.windows, deliver, beatMs: 800 });
  const consent = createConsentGate({
    permissions,
    prompt,
    pending,
    portName: () => 'nostr-consent',
    hostOf: hostFromSender,
    previewOf: buildPreview,
    // No device granted at all: typed refusal before any prompt (US-1708).
    devicePresent: async () => {
      const dev = await findGrantedDevice(navigator_)();
      if (!dev) throw new DeviceAbsentError();
    },
  });

  const activeSlot = createActiveSlotStore({ storage: chrome_.storage.local });
  const handlers = createHandlers({
    device,
    consent,
    previewOf: buildPreview,
    listGrants: () => permissions.list(),
    revoke: (host) => permissions.revoke(host),
    onPromptDecision: async ([decision]) => prompt.decide(decision ?? {}),
    getActiveSlot: activeSlot.get,
    setActiveSlot: activeSlot.set,
  });
  const route = createDispatch(handlers);

  chrome_.runtime.onConnect.addListener((port) => {
    attachPortListener(port, route);
    // US-1723 — a prompt port's name is `nostr-prompt-<requestId>`; bind it so
    // settle() can push the outcome frame to exactly that request's window.
    const bound = /^nostr-prompt-(.+)$/.exec(port.name);
    if (bound) requestPorts.set(bound[1], port);
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
