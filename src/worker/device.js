// US-1693/US-1694 — the device owner. The worker holds exactly one
// CtapVendorTransport for its lifetime and runs exactly one vendor
// transaction at a time: the firmware refuses a second vendor request while
// a touch window is parked (6985, red-team F6), so a second request WAITS
// on a FIFO queue rather than reaching the firmware — and a queued request
// still runs after the first one ends in a touch-timeout 6985.
//
// Absence is typed and loud, and refused, not queued: a request that
// arrives with no granted device fails on its own merits (the loudness
// model). The chooser is never opened here — opening it needs a user
// gesture and belongs to the popup (US-1702); the worker only ever reuses
// what `navigator.hid.getDevices()` already granted. A stray no-gesture
// SecurityError maps to the same typed absence.
//
// This module is the ONLY place in the repo that constructs a transport
// (asserted by a grep test, US-1693).

import {
  CtapVendorTransport,
  USAGE_PAGE,
  USAGE_ID,
} from '../core/ctaphid.js';
import { DeviceAbsentError, mapDeviceError } from '../core/loudness.js';
import { QueueFullError } from './errors.js';

export const QUEUE_MAX = 64;

/** The granted-device lookup: the vendor interface only. */
export function findGrantedDevice(navigator_ = navigator) {
  return async () => {
    if (!navigator_?.hid) return null;
    const devices = await navigator_.hid.getDevices();
    return (
      devices.find((d) =>
        d.collections?.some(
          (c) => c.usagePage === USAGE_PAGE && c.usage === USAGE_ID,
        ),
      ) ?? null
    );
  };
}

/**
 * The device owner. Dependencies are injectable so the tests drive a
 * scripted double; production passes nothing and gets the real WebHID path.
 */
export function createDeviceOwner({
  getGrantedDevice = findGrantedDevice(),
  createTransport = (dev) => new CtapVendorTransport(dev),
  openTransport = (t, dev) => t.open(),
  now = () => Date.now(),
} = {}) {
  let transport = null;
  let device = null;
  let opening = null;
  const queue = [];
  let draining = false;
  // The touch-free health check is rate-limited (US-1702): >=1 s between
  // PING probes.
  let lastPingAt = 0;

  async function ensureTransport() {
    if (transport) return transport;
    if (!opening) {
      opening = (async () => {
        const dev = await getGrantedDevice();
        if (!dev) throw new DeviceAbsentError();
        const t = createTransport(dev);
        try {
          await openTransport(t, dev);
        } catch (err) {
          // A failed open must not cache a half-open transport; and a
          // no-gesture SecurityError from a stray chooser call is the same
          // typed absence (the gap the OpenXrypt review found — the core's
          // mapDeviceError does not name SecurityError, so it is mapped here,
          // at the only layer that can see it).
          if (err?.name === 'SecurityError') throw new DeviceAbsentError();
          throw mapDeviceError(err);
        }
        device = dev;
        transport = t;
        return t;
      })();
      opening.catch(() => {
        // A failed acquisition is not cached — the next request retries.
        opening = null;
      });
    }
    return opening;
  }

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (queue.length > 0) {
        const job = queue.shift();
        if (job.dropped) continue; // its port died while queued
        try {
          const t = await ensureTransport();
          const result = await t.vendor(job.cmd, job.idx, job.arg, job.opts);
          job.resolve(result);
        } catch (err) {
          job.reject(err);
        }
      }
    } finally {
      draining = false;
    }
  }

  return {
    /** The raw device command, serialized. This is the only way anything
     *  in the worker touches the firmware. `tag` names the requesting port
     *  so a disconnect can drop its queued (never started) jobs. */
    async run(cmd, idx, arg, opts = {}, tag = null) {
      if (queue.length >= QUEUE_MAX) throw new QueueFullError(QUEUE_MAX);
      return new Promise((resolve, reject) => {
        queue.push({ cmd, idx, arg, opts, tag, resolve, reject, dropped: false });
        drain();
      });
    },

    /** A port disconnected: its queued jobs are dropped before dispatch —
     *  rejected typed, never left hanging, never sent to the device. */
    dropQueued(tag) {
      for (const job of queue) {
        if (job.tag !== tag || job.dropped) continue;
        job.dropped = true;
        job.reject(
          Object.assign(new Error('the requesting port disconnected — request dropped'), {
            name: 'PortDisconnectedError',
            code: 'port-disconnected',
          }),
        );
      }
    },

    /** Touch-free PING (0x40), rate-limited to one probe per second. */
    async ping() {
      const since = now() - lastPingAt;
      if (since < 1000) throw Object.assign(new Error('health check rate-limited'), { code: 'RATE_LIMITED', name: 'RateLimitError' });
      lastPingAt = now();
      try {
        const t = await ensureTransport();
        return await t.vendor(0x40, 0, new Uint8Array(0), { timeoutMs: 5000 });
      } catch (err) {
        if (err instanceof DeviceAbsentError || err?.code === 'DEVICE_ABSENT') throw err;
        throw mapDeviceError(err);
      }
    },

    /** State for the popup's device card. */
    snapshot() {
      return {
        hasTransport: transport !== null,
        deviceName: device?.productName ?? null,
        queued: queue.length,
      };
    },

    /** The transport is gone (device unplugged): the next request reopens. */
    forget() {
      transport = null;
      device = null;
      opening = null;
    },
  };
}
