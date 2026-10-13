// The extension-page side of the port protocol (US-1692): open a
// `nostr-<seq>` port, send {id, method, args} frames, match the replies by
// id. Used by the popup and the prompt window — both trusted extension
// pages, both bound to the worker's method table.
//
// US-1741 board run — the MV3 worker idles out (~30 s) and the port dies
// with it. The client heals the way the content bridge always has: a
// disconnected port is replaced lazily, under the SAME name (re-delivery and
// the prompt's request binding ride the name), with the listeners
// re-attached; a send that still fails rejects typed TransportError.
//
// US-1744 board run, take two — Chrome does NOT reliably deliver
// port.onDisconnect when the worker is killed by idleness: the page's port
// object stays "connected" and postMessage silently black-holes (a live
// connect attempt hung while a CDP monitor saw the worker start ZERO times).
// Healing therefore cannot depend on the disconnect event: the client tracks
// its last inbound frame and a call after the staleness window abandons the
// silent port and reconnects BEFORE sending. A late disconnect from an
// abandoned port never touches the fresh one.

const STALE_MS = 20000; // the worker's idle window is ~30 s

export function createPortClient({ chrome_ = chrome, name = null, now = Date.now } = {}) {
  const portName = name ?? `nostr-page-${Math.floor(Math.random() * 1e9).toString(36)}`;
  let seq = 0;
  const pending = new Map();
  const eventFns = new Set();
  const disconnectFns = new Set();
  let port = connect();
  let lastSeen = now();

  function connect() {
    const p = chrome_.runtime.connect({ name: portName });
    p.onMessage.addListener(handle);
    p.onDisconnect.addListener(() => {
      // The worker restarted (or died): drop the dead port — but only if it
      // is still the current one (US-1744: an ABANDONED port's late
      // disconnect must not null the fresh replacement).
      if (port === p) port = null;
      for (const fn of [...disconnectFns]) fn();
    });
    return p;
  }

  function handle(msg) {
    if (!msg) return;
    lastSeen = now(); // inbound traffic proves the port is alive
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
    if (!port || now() - lastSeen > STALE_MS) {
      // US-1741 — a dead port heals; US-1744 — a SILENT port (its disconnect
      // event never fired) is abandoned on staleness. Both reconnect under
      // the same name; the old port object is simply left behind.
      port = connect();
    }
    try {
      port.postMessage(frame);
    } catch {
      // The port died between the check and this send: one reconnect +
      // retry; a second failure propagates (call() types it).
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
