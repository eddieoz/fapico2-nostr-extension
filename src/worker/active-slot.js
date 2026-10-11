// US-1710 — the active-key setting: one global slot index in
// chrome.storage.local. Read at request time by the handlers (the injected
// getActiveSlot accessor) — never cached, because a cached value goes stale
// across exactly the MV3 worker deaths the pending-request store is built
// to survive. The handlers own the validation (refuse-on-invalid); this
// adapter is only the storage shape.
export const ACTIVE_SLOT_KEY = 'nostrActiveSlot';

export function createActiveSlotStore({ storage }) {
  return {
    async get() {
      const got = await storage.get(ACTIVE_SLOT_KEY);
      return got?.[ACTIVE_SLOT_KEY];
    },
    async set(slot) {
      await storage.set({ [ACTIVE_SLOT_KEY]: slot });
    },
  };
}
