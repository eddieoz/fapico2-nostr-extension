// The extension-page side of the port protocol (US-1692): open a
// `nostr-<seq>` port, send {id, method, args} frames, match the replies by
// id. Used by the popup and the prompt window — both trusted extension
// pages, both bound to the worker's method table.
//
// US-1741 board run — the MV3 worker idles out (~30 s) and the port dies
// with it; a page whose human was mid-flow (the device chooser, a decision)
// then posted into a dead port and Chrome's internal "Attempting to use a
// disconnected port object" leaked into the UI. The client now heals the
// same way the content bridge always has: a disconnected port is replaced
// LAZILY on the next send, under the SAME name (re-delivery and the
// prompt's request binding ride the name), with the listeners re-attached.
// A send that still fails rejects typed TransportError — Chrome's internal
// strings never reach a page.

export function createPortClient({ chrome_ = chrome, name = null } = {}) {
  const portName = name ?? `nostr-page-${Math.floor(Math.random() * 1e9).toString(36)}`;
  let seq = 0;
  const pending = new Map();
  const eventFns = new Set();
  const disconnectFns = new Set();
  let port = connect();

  function connect() {
    const p = chrome_.runtime.connect({ name: portName });
    p.onMessage.addListener(handle);
    p.onDisconnect.addListener(() => {
      // The worker restarted (or died): drop the dead port. The next send
      // reconnects; pages subscribed to onDisconnect still hear about it.
      port = null;
      for (const fn of [...disconnectFns]) fn();
    });
    return p;
  }

  function handle(msg) {
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
  }

  function send(frame) {
    if (!port) port = connect(); // US-1741 — lazy reconnect under the same name
    try {
      port.postMessage(frame);
    } catch {
      // The port died between the disconnect event and this send: one
      // reconnect + retry; a second failure propagates (call() types it).
      port = connect();
      port.postMessage(frame);
    }
  }

  return {
    portName,
    call(method, ...args) {
      return new Promise((resolve, reject) => {
        const id = `c${seq++}`;
        pending.set(id, { resolve, reject });
        try {
          send({ id, method, args });
        } catch {
          pending.delete(id);
          // US-1741 — typed, never Chrome's internal string.
          const err = new Error('the connection to the extension was lost — try again');
          err.name = 'TransportError';
          err.code = 'transport-lost';
          reject(err);
        }
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
