(() => {
  // src/shared/port-client.js
  function createPortClient({ chrome_ = chrome, name = null } = {}) {
    const portName = name ?? `nostr-page-${Math.floor(Math.random() * 1e9).toString(36)}`;
    let seq = 0;
    const pending = /* @__PURE__ */ new Map();
    const port = chrome_.runtime.connect({ name: portName });
    port.onMessage.addListener((msg) => {
      if (!msg || typeof msg.id === "undefined") return;
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) {
        const err = new Error(msg.error.message);
        err.name = msg.error.name;
        err.code = msg.error.code;
        if (msg.error.sw !== void 0) err.sw = msg.error.sw;
        if (msg.error.device !== void 0) err.device = msg.error.device;
        p.reject(err);
      } else {
        p.resolve(msg.result);
      }
    });
    return {
      portName,
      call(method2, ...args) {
        return new Promise((resolve, reject) => {
          const id = `c${seq++}`;
          pending.set(id, { resolve, reject });
          port.postMessage({ id, method: method2, args });
        });
      }
    };
  }

  // src/prompt/prompt.js
  var api = createPortClient({ name: "nostr-prompt" });
  var $ = (id) => document.getElementById(id);
  var METHOD_WORDS = {
    get_public_key: "read the public key (npub) of your identity",
    sign_event: "sign a Nostr event with your device key",
    list_keys: "list the identities on your device",
    nip44_encrypt: "encrypt a message with your device key",
    nip44_decrypt: "decrypt a message with your device key"
  };
  var params = new URLSearchParams(location.search);
  var requestId = params.get("request") ?? "";
  var method = params.get("method") ?? "";
  var host = params.get("host") ?? "unknown site";
  var preview = params.get("preview") ?? "";
  $("host").textContent = host;
  $("wants").innerHTML = `This site wants to <span class="what">${METHOD_WORDS[method] ?? method}</span>.` + (preview ? `<br>${escapeHtml(preview)}` : "");
  $("hint").textContent = method === "get_public_key" ? "Your npub is public \u2014 but which sites may see it is still your call." : "Nothing is signed, encrypted or decrypted until you approve.";
  $("approve").addEventListener("click", () => {
    api.call("prompt_decision", {
      requestId,
      approve: true,
      remember: $("remember").checked
    }).finally(() => window.close());
  });
  $("deny").addEventListener("click", () => {
    api.call("prompt_decision", { requestId, approve: false }).finally(() => window.close());
  });
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }
})();
