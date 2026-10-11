// The extension-page side of the port protocol (US-1692): open a
// `nostr-<seq>` port, send {id, method, args} frames, match the replies by
// id. Used by the popup and the prompt window — both trusted extension
// pages, both bound to the worker's method table.
export function createPortClient({ chrome_ = chrome, name = null } = {}) {
  const portName = name ?? `nostr-page-${Math.floor(Math.random() * 1e9).toString(36)}`;
  let seq = 0;
  const pending = new Map();
  const port = chrome_.runtime.connect({ name: portName });
  port.onMessage.addListener((msg) => {
    if (!msg || typeof msg.id === 'undefined') return;
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
  };
}
