(() => {
  // src/core/window_nostr.js
  function reviveBridgeError(blob) {
    const err = new Error(blob.message);
    err.name = blob.name;
    err.code = blob.code;
    err.sw = blob.sw;
    return err;
  }

  // src/shared/protocol.js
  var NOSTR_MARKER = "fapico:nostr:1";
  var MAX_PAGE_PAYLOAD_CHARS = 1 << 20;

  // src/provider/provider.js
  var utf8 = new TextEncoder();
  var decoder = new TextDecoder();
  function utf8ToHex(s) {
    return [...utf8.encode(s)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  function randomUUID() {
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = b[6] & 15 | 64;
    b[8] = b[8] & 63 | 128;
    const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  function installProvider(win) {
    if (win.nostr) return false;
    const pending = /* @__PURE__ */ new Map();
    win.addEventListener("message", (ev) => {
      if (ev.source !== win) return;
      const d = ev.data;
      if (!d || d.marker !== NOSTR_MARKER || d.dir !== "reply") return;
      const p = pending.get(d.id);
      if (!p) return;
      pending.delete(d.id);
      if (d.reply?.error) p.reject(reviveBridgeError(d.reply.error));
      else p.resolve(d.reply?.result);
    });
    const call = (method, ...args) => new Promise((resolve, reject) => {
      const id = randomUUID();
      pending.set(id, { resolve, reject });
      win.postMessage(
        { marker: NOSTR_MARKER, dir: "call", id, method, args, host: win.location.host },
        win.location.origin
      );
    });
    win.nostr = {
      getPublicKey: () => call("get_public_key"),
      signEvent: (event) => call("sign_event", event),
      listKeys: () => call("list_keys"),
      nip44: {
        // NIP-44's plaintext is utf8 text; it crosses as hex so the frame
        // stays JSON-serializable. The worker does the device framing.
        encrypt: (peer, plaintext) => call("nip44_encrypt", peer, utf8ToHex(String(plaintext))),
        // US-1747 — the worker returns the plaintext as a byte-array (the
        // device's raw answer, spread for JSON); decode it to utf8 here. The
        // old hexToUtf8 expected a hex string and mangled the byte-array.
        decrypt: (sender, payload) => call("nip44_decrypt", sender, payload).then(
          (bytes) => decoder.decode(Uint8Array.from(bytes))
        )
      }
    };
    return true;
  }
  if (typeof window !== "undefined") {
    installProvider(window);
  }
})();
