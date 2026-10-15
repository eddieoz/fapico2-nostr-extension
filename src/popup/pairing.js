// US-1702 — pairing: the popup's Connect flow is the product's ONLY chooser.
// requestDevice runs in an extension page (popup.js hands off to the
// connect.html window: a chooser anchored to the action popup is cancelled
// the moment the popup blurs); the worker is then told to re-adopt the
// granted device (pair_device) — the worker never opens a chooser. The
// health check is touch-free and rate-limited (>=1 s between probes), and
// the last answer is persisted to storage.session so the popup reopens to
// truth.

export const VENDOR_FILTER = { usagePage: 0xff00, usage: 0x01 };

export function createPairing({ requestDevice, call, persist = () => {}, now = () => Date.now() }) {
  let lastProbeAt = 0;
  let lastHealth = null;

  return {
    /** The Connect flow — call from the click handler only. */
    async connect() {
      const devices = await requestDevice({ filters: [VENDOR_FILTER] });
      if (!devices || devices.length === 0) {
        const err = new Error('no device selected');
        err.name = 'NotFoundError';
        throw err;
      }
      // The chooser has registered the grant with the browser; the worker
      // forgets any stale transport and re-pings the interface. Its answer
      // IS the card state — a second probe here would trip the worker's
      // 1 s rate window and paint a working device as "device error".
      // US-1706 — the parsed GET_INFO body rides along so the PIN surface
      // derives from the same answer that says "connected".
      const res = await call('pair_device');
      lastHealth =
        res.state === 'connected'
          ? { state: 'connected', info: res.info ?? null }
          : { state: 'error', message: res.message };
      persist(lastHealth);
      return lastHealth;
    },

    /** Touch-free PING, rate-limited. Returns the device-card state. */
    async health({ force = false } = {}) {
      const t = now();
      if (!force && t - lastProbeAt < 1000) return lastHealth;
      lastProbeAt = t;
      try {
        const res = await call('device_status');
        // US-1706 — `info` (the GET_INFO body) is what the PIN custody UI
        // derives from: capability bits, PIN-set and session-unlocked flags.
        // It rides the health answer; a state without a body degrades to
        // null and every PIN surface hides.
        lastHealth =
          res.state === 'connected'
            ? { state: 'connected', info: res.info ?? null }
            : res.state === 'busy'
              ? { state: 'busy' } // the probe window, not the device — amber, retried
              : res.code === 'DEVICE_ABSENT'
                ? { state: 'absent' }
                : { state: 'error', message: res.message };
      } catch (err) {
        lastHealth = { state: 'error', message: err.message };
      }
      persist(lastHealth);
      return lastHealth;
    },

    get lastHealth() {
      return lastHealth;
    },
  };
}
