(() => {
  // src/shared/protocol.js
  var NOSTR_MARKER = "fapico:nostr:1";
  var PAGE_METHODS = /* @__PURE__ */ new Set([
    "get_public_key",
    "sign_event",
    "list_keys",
    "nip44_encrypt",
    "nip44_decrypt"
  ]);
  var MAX_PAGE_PAYLOAD_CHARS = 1 << 20;
  function isPageMethod(method) {
    return typeof method === "string" && PAGE_METHODS.has(method);
  }

  // src/content/bridge.js
  var PROVIDER_TAG_FLAG = "data-fapico-nostr-provider";
  function injectProvider(win, { url } = {}) {
    if (win.nostr) return null;
    const doc = win.document;
    if (doc.querySelector(`script[${PROVIDER_TAG_FLAG}]`)) {
      return doc.querySelector(`script[${PROVIDER_TAG_FLAG}]`);
    }
    const script = doc.createElement("script");
    script.src = url;
    script.setAttribute(PROVIDER_TAG_FLAG, "true");
    (doc.head ?? doc.documentElement).appendChild(script);
    return script;
  }
  function createBridgeRelay({ win, connect, warn = console.warn }) {
    let port = null;
    let seq = 0;
    const portName = `nostr-${Math.floor(Math.random() * 1e9).toString(36)}`;
    function ensurePort() {
      if (port) return port;
      port = connect(portName);
      port.onMessage.addListener((msg) => {
        if (!msg || typeof msg.id === "undefined") return;
        const reply = msg.error ? { error: msg.error } : { result: msg.result };
        win.postMessage(
          { marker: NOSTR_MARKER, dir: "reply", id: msg.id, reply },
          win.location.origin
        );
      });
      port.onDisconnect.addListener(() => {
        port = null;
      });
      return port;
    }
    return function relay(ev) {
      if (ev.source !== win) return;
      const d = ev.data;
      if (!d || d.marker !== NOSTR_MARKER || d.dir !== "call") return;
      const { id, method, args = [] } = d;
      if (!isPageMethod(method)) {
        warn(`fapico2 nostr: relayed method "${method}" refused \u2014 not in the page allow-list`);
        win.postMessage(
          {
            marker: NOSTR_MARKER,
            dir: "reply",
            id,
            reply: {
              error: { name: "ForbiddenMethodError", code: "forbidden-method", message: `${method} is not offered to pages` }
            }
          },
          win.location.origin
        );
        return;
      }
      try {
        if (JSON.stringify(d).length > MAX_PAGE_PAYLOAD_CHARS) {
          warn("fapico2 nostr: oversized relay payload dropped");
          win.postMessage(
            {
              marker: NOSTR_MARKER,
              dir: "reply",
              id,
              reply: {
                error: { name: "PayloadTooLargeError", code: "payload-too-large", message: "the relay refuses oversized payloads" }
              }
            },
            win.location.origin
          );
          return;
        }
      } catch {
        warn("fapico2 nostr: unserializable relay payload dropped");
        return;
      }
      const p = ensurePort();
      p.postMessage({ id, method, args, host: d.host });
      seq++;
    };
  }
  function initBridge({
    win = window,
    chrome_ = typeof chrome !== "undefined" ? chrome : void 0
  } = {}) {
    if (!chrome_?.runtime?.id) return false;
    injectProvider(win, { url: chrome_.runtime.getURL("provider.js") });
    win.addEventListener("message", createBridgeRelay({ win, connect: (name) => chrome_.runtime.connect({ name }) }));
    return true;
  }
  if (typeof window !== "undefined" && typeof chrome !== "undefined" && chrome.runtime?.id) {
    initBridge();
  }
})();
