// The extension-page side of the port protocol (US-1692): open a
// `nostr-<seq>` port, send {id, method, args} frames, match the replies by
// id. Used by the popup and the prompt window — both trusted extension
// pages, both bound to the worker's method table.
export function createPortClient({ chrome_ = chrome, name = null } = {}) {
  const portName = name ?? `nostr-page-${Math.floor(Math.random() * 1e9).toString(36)}`;
  let seq = 0;
  const pending = new Map();
  const eventFns = new Set();
  const disconnectFns = new Set();
  const port = chrome_.runtime.connect({ name: portName });

  port.onMessage.addListener((msg) => {
    if (!msg) return;
    // US-1721 — a frame WITH an id is a reply to a pending call (US-1692
    // routing, untouched). A frame WITHOUT an id is a worker push
    // ({event, ...}); it goes only to the onEvent listeners and never to a
    // pending call, so no frame is ever consumed twice.
    if (typeof msg.id !== 'undefined') {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) {
        const err = new Error(msg.error.message);
        err.name = msg.error.name;
        err.code = msg.error.code;
        if (msg.error.sw !== undefined) err.sw = msg.error.sw;
        if (msg.error.device !== undefined) err.device = msg.error.device;
        p.reject(err);
      } else {
        p.resolve(msg.result);
      }
      return;
    }
    for (const fn of [...eventFns]) fn(msg);
  });

  // US-1721 — a disconnected port means the worker restarted (or the tab
  // closed); hand it to the onDisconnect listeners so a page can say
  // "extension restarted" instead of silently dead-lettering.
  port.onDisconnect.addListener(() => {
    for (const fn of [...disconnectFns]) fn();
  });

  return {
    portName,
    call(method, ...args) {
      return new Promise((resolve, reject) => {
        const id = `c${seq++}`;
        pending.set(id, { resolve, reject });
        port.postMessage({ id, method, args });
      });
    },
    // US-1721 — subscribe to worker push frames ({event, ...}, no id). Returns
    // an unsubscribe fn.
    onEvent(fn) {
      eventFns.add(fn);
      return () => {
        eventFns.delete(fn);
      };
    },
    // US-1721 — subscribe to port disconnect. Returns an unsubscribe fn.
    onDisconnect(fn) {
      disconnectFns.add(fn);
      return () => {
        disconnectFns.delete(fn);
      };
    },
  };
}
