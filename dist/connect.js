(() => {
  // src/shared/port-client.js
  var STALE_MS = 2e4;
  var HEARTBEAT_MS = 2e4;
  function createPortClient({ chrome_ = chrome, name = null, now = Date.now, heartbeatMs = HEARTBEAT_MS } = {}) {
    const portName = name ?? `nostr-page-${Math.floor(Math.random() * 1e9).toString(36)}`;
    let seq = 0;
    const pending = /* @__PURE__ */ new Map();
    const eventFns = /* @__PURE__ */ new Set();
    const disconnectFns = /* @__PURE__ */ new Set();
    let port = connect();
    let lastSeen = now();
    function connect() {
      const p = chrome_.runtime.connect({ name: portName });
      p.onMessage.addListener(handle);
      p.onDisconnect.addListener(() => {
        if (port === p) port = null;
        for (const fn of [...disconnectFns]) fn();
      });
      return p;
    }
    function handle(msg) {
      if (!msg) return;
      lastSeen = now();
      if (typeof msg.id !== "undefined") {
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
        return;
      }
      for (const fn of [...eventFns]) fn(msg);
    }
    function send(frame) {
      if (!port || now() - lastSeen > STALE_MS) {
        port = connect();
      }
      try {
        port.postMessage(frame);
      } catch {
        port = connect();
        port.postMessage(frame);
      }
    }
    let heartbeatTimer = null;
    function call(method, ...args) {
      return new Promise((resolve, reject) => {
        const id = `c${seq++}`;
        pending.set(id, { resolve, reject });
        try {
          send({ id, method, args });
        } catch {
          pending.delete(id);
          const err = new Error("the connection to the extension was lost \u2014 try again");
          err.name = "TransportError";
          err.code = "transport-lost";
          reject(err);
        }
      });
    }
    if (heartbeatMs > 0) {
      heartbeatTimer = setInterval(() => {
        call("echo").catch(() => {
        });
      }, heartbeatMs);
    }
    return {
      portName,
      /** US-1745 — stops the heartbeat (tests; pages die naturally). */
      dispose() {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      },
      call,
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
      }
    };
  }

  // src/popup/pairing.js
  var VENDOR_FILTER = { usagePage: 65280, usage: 1 };
  function createPairing({ requestDevice, call, persist = () => {
  }, now = () => Date.now() }) {
    let lastProbeAt = 0;
    let lastHealth = null;
    return {
      /** The Connect flow — call from the click handler only. */
      async connect() {
        const devices = await requestDevice({ filters: [VENDOR_FILTER] });
        if (!devices || devices.length === 0) {
          const err = new Error("no device selected");
          err.name = "NotFoundError";
          throw err;
        }
        const res = await call("pair_device");
        lastHealth = res.state === "connected" ? { state: "connected", info: res.info ?? null } : { state: "error", message: res.message };
        persist(lastHealth);
        return lastHealth;
      },
      /** Touch-free PING, rate-limited. Returns the device-card state. */
      async health({ force = false } = {}) {
        const t = now();
        if (!force && t - lastProbeAt < 1e3) return lastHealth;
        lastProbeAt = t;
        try {
          const res = await call("device_status");
          lastHealth = res.state === "connected" ? { state: "connected", info: res.info ?? null } : res.state === "busy" ? { state: "busy" } : res.code === "DEVICE_ABSENT" ? { state: "absent" } : { state: "error", message: res.message };
        } catch (err) {
          lastHealth = { state: "error", message: err.message };
        }
        persist(lastHealth);
        return lastHealth;
      },
      get lastHealth() {
        return lastHealth;
      }
    };
  }

  // src/popup/connect.js
  function closeSelf() {
    try {
      chrome.tabs.getCurrent((tab) => {
        if (tab) chrome.tabs.remove(tab.id);
        else window.close();
      });
    } catch {
      window.close();
    }
  }
  function createConnectFlow({ requestDevice, call, persist = () => {
  }, onClose = () => {
  }, autoCloseMs = 1500, busyRetryMs = 1100 }) {
    const pairing = createPairing({ requestDevice, call, persist });
    let closed = false;
    async function listKeyCount() {
      try {
        const keys = await call("list_keys");
        return Array.isArray(keys) ? keys.length : 0;
      } catch {
        return null;
      }
    }
    return {
      /** The Connect click — runs the chooser in this gesture. */
      async connect() {
        try {
          const health = await pairing.connect();
          if (health.state === "connected" && !closed) {
            if (handoffDecision(await listKeyCount()).handoff) {
              return { ...health, handoff: true };
            }
            closed = true;
            setTimeout(onClose, autoCloseMs);
          }
          return health;
        } catch (err) {
          if (err?.name === "NotFoundError") return { state: "absent", cancelled: true };
          throw err;
        }
      },
      /**
       * Touch-free probe for boot — a reopened window shows the live truth.
       * A `busy` answer is the worker's 1 s probe window (the popup's own boot
       * probe fired moments before this window opened), not a fault: one retry
       * after the window lapses, exactly like the popup's boot path.
       */
      async health(opts) {
        let h = await pairing.health(opts);
        if (h?.state === "busy") {
          await new Promise((r) => setTimeout(r, busyRetryMs));
          h = await pairing.health({ ...opts, force: true });
        }
        return h;
      },
      get lastHealth() {
        return pairing.lastHealth;
      }
    };
  }
  function handoffDecision(keyCount) {
    if (keyCount == null) return { close: true, handoff: false };
    return { close: keyCount > 0, handoff: keyCount === 0 };
  }
  function connectStateLabel(state, message) {
    switch (state) {
      case "connected":
        return { line: "fapico2 board connected", dot: "connected", lineClass: "connect-state connected" };
      case "busy":
        return { line: "busy \u2014 retrying in a second", dot: "busy", lineClass: "connect-state waiting" };
      case "error":
        return { line: `device error \u2014 ${message ?? "try again"}`, dot: "error", lineClass: "connect-state error" };
      case "idle":
      case "absent":
      default:
        return { line: "no board granted yet", dot: "absent", lineClass: "connect-state" };
    }
  }
  if (typeof document !== "undefined" && document.getElementById("connect")) {
    let notice = function(msg, cls = "") {
      const el = $("notice");
      el.hidden = !msg;
      el.textContent = msg ?? "";
      el.className = `notice ${cls}`;
    }, setDot = function(stateName) {
      const dot = $("device-dot");
      dot.className = stateName;
      dot.textContent = stateName === "connected" ? "connected" : stateName === "absent" ? "not present" : stateName === "busy" ? "busy" : stateName === "error" ? "error" : "checking";
    }, render = function(h) {
      if (!h) return;
      if (h.handoff) {
        setDot("connected");
        const el2 = $("connect-state");
        el2.textContent = "connected \u2014 open the fapico2 toolbar icon to create your first key";
        el2.className = "connect-state connected";
        return;
      }
      const { line, dot, lineClass } = connectStateLabel(h.state, h.message);
      setDot(dot);
      const el = $("connect-state");
      el.textContent = line;
      el.className = lineClass;
    };
    const api = createPortClient();
    const $ = (id) => document.getElementById(id);
    const flow = createConnectFlow({
      requestDevice: (opts) => navigator.hid.requestDevice(opts),
      call: api.call,
      persist: (h) => {
        try {
          chrome.storage.session.set({ nostrDeviceCard: h });
        } catch {
        }
      },
      onClose: closeSelf
    });
    $("connect").addEventListener("click", async () => {
      if (!navigator.hid) {
        notice("WebHID is not available in this browser", "err");
        return;
      }
      $("connect").disabled = true;
      $("connect-state").textContent = "waiting for the picker\u2026";
      $("connect-state").className = "connect-state waiting";
      notice("");
      try {
        const health = await flow.connect();
        render(health);
        if (health.cancelled) {
          notice("no device selected \u2014 click Connect to try again", "err");
        } else if (health.state !== "connected") {
          notice(health.message ?? "pairing failed", "err");
        }
      } catch (err) {
        notice(err.message ?? "the chooser failed", "err");
      } finally {
        $("connect").disabled = false;
      }
    });
    (async function boot() {
      const h = await flow.health({ force: true });
      render(h);
      if (h.state === "connected") {
        setTimeout(closeSelf, 1500);
      }
    })();
  }
})();
