// US-1702 — pairing: the popup's Connect button is the product's ONLY
// chooser. `requestDevice` runs in this user-gesture context; the worker is
// then told to re-adopt the granted device (pair_device) — the worker never
// opens a chooser. The health check is touch-free and rate-limited (>=1 s
// between probes), and the last answer is persisted to storage.session so
// the popup reopens to truth.

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
      const res = await call('pair_device');
      lastHealth =
        res.state === 'connected' ? { state: 'connected' } : { state: 'error', message: res.message };
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
        lastHealth =
          res.state === 'connected'
            ? { state: 'connected' }
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
