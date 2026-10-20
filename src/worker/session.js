// US-1695 — MV3 lifetime: a SIGN waiting for a human touch can outlive an
// MV3 worker idleness kill, so the pending-request map is persisted to
// `chrome.storage.session` and re-adopted on boot. The persisted record
// stores no key material — id, method, a preview string, host, port name,
// prompt window id, state — only what re-delivery and the prompt need.
//
// Boot re-adoption settles every stranded 'pending' record as a typed
// ceremony-interrupted (never a hang), EXCEPT a record whose prompt window
// still exists — that decision can still arrive and is waited for. A
// record that already settled but was never delivered (the port died with
// the old worker) keeps its outcome: the bridge reconnects the port under
// the same name and the outstanding reply is re-delivered verbatim.
//
// The storage.session access level is widened to
// TRUSTED_AND_UNTRUSTED_CONTEXTS at the worker's boot (the OpenXrypt
// write-block finding, fixed at the only place that can fix it) —
// `widenSessionAccess` in worker.js.

import { CEREMONY_INTERRUPTED } from './errors.js';

export const PENDING_KEY = 'pendingRequests';

/**
 * The pending-request store over a `chrome.storage.session`-shaped stub
 * (get/set/remove). All mutation is persisted before the caller proceeds,
 * so a worker death between steps never loses a state transition.
 */
export function createPendingStore({ storage, windowExists = () => false } = {}) {
  let records = new Map();
  let loaded = false;

  async function flush() {
    await storage.set({ [PENDING_KEY]: [...records.values()] });
  }

  return {
    async load() {
      const got = await storage.get(PENDING_KEY);
      const raw = got?.[PENDING_KEY];
      records = new Map();
      if (Array.isArray(raw)) {
        for (const r of raw) {
          // Fail closed on a corrupted record: skip it, never adopt garbage.
          if (r && typeof r.id !== 'undefined' && typeof r.portName === 'string') {
            records.set(r.id, r);
          }
        }
      }
      loaded = true;
      return records;
    },

    async begin({ id, method, preview = '', host = '', portName, promptWindowId = null }) {
      if (!loaded) await this.load();
      records.set(id, { id, method, preview, host, portName, promptWindowId, state: 'pending', outcome: null });
      await flush();
    },

    async settle(id, outcome) {
      const r = records.get(id);
      if (!r) return;
      r.state = 'settled';
      r.outcome = outcome;
      r.promptWindowId = null;
      await flush();
    },

    async forget(id) {
      records.delete(id);
      await flush();
    },

    /**
     * Boot re-adoption. Every still-pending record whose prompt window is
     * gone settles `ceremony-interrupted` — the ceremony cannot be resumed,
     * and silence would be a hang. A record with a living prompt window
     * stays pending for its decision. Returns the interrupted ids.
     */
    async adopt() {
      if (!loaded) await this.load();
      const interrupted = [];
      for (const r of records.values()) {
        if (r.state !== 'pending') continue;
        const windowAlive =
          r.promptWindowId != null && windowExists(r.promptWindowId);
        if (windowAlive) continue;
        await this.settle(r.id, { error: { ...CEREMONY_INTERRUPTED } });
        interrupted.push(r.id);
      }
      return interrupted;
    },

    /** Settled-but-undelivered records for one port name, removed on take.
     *  US-1751 — the reply echoes the BARE frame id: the record's id is the
     *  dispatch composite (portName/frameId, dispatch.js), but the provider's
     *  pending map matches by the bare id the call was made with. The record
     *  knows its own port name, so the prefix is stripped exactly — a bare id
     *  (a direct call with no port) passes through unchanged. */
    async takeForPort(portName) {
      if (!loaded) await this.load();
      const out = [];
      for (const r of [...records.values()]) {
        if (r.portName !== portName) continue;
        if (r.state === 'settled' && r.outcome) {
          const prefix = `${r.portName}/`;
          out.push({
            id: r.id.startsWith(prefix) ? r.id.slice(prefix.length) : r.id,
            ...r.outcome,
          });
          await this.forget(r.id);
        }
      }
      return out;
    },

    get(id) {
      return records.get(id) ?? null;
    },

    get size() {
      return records.size;
    },
  };
}
