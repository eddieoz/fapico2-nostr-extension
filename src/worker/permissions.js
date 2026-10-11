// US-1699 — the permission store: per-host, per-method grants in
// chrome.storage.local as `{ [host]: { grantedAt, methods: {…} } }`; a
// request is granted immediately iff a persisted grant covers (host, method).
// A this-time-only grant (unchecked "remember") is held in worker memory
// and dies with the worker — never persisted. Revocation deletes the host
// record. A corrupted record fails closed (prompt again), never open.
//
// The store never stores more than host + method + timestamp; getPublicKey
// prompts like everything else (identity disclosure is a consent event).

export const GRANTS_KEY = 'grants';

/** The method names a persisted grant may cover — exactly the relayed set. */
export const GRANTABLE_METHODS = new Set([
  'get_public_key',
  'sign_event',
  'list_keys',
  'nip44_encrypt',
  'nip44_decrypt',
]);

export function createPermissionStore({ storage, now = () => Date.now() } = {}) {
  // Session-only grants: `${host}|${method}` strings, memory only.
  const sessionGrants = new Set();

  async function readRaw() {
    const got = await storage.get(GRANTS_KEY);
    const raw = got?.[GRANTS_KEY];
    // Fail closed: anything that is not a plain object of plain objects is
    // treated as no grants — the prompt runs again, never a silent allow.
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out = {};
    for (const [host, rec] of Object.entries(raw)) {
      if (
        typeof host === 'string' &&
        rec &&
        typeof rec === 'object' &&
        typeof rec.grantedAt === 'number' &&
        rec.methods &&
        typeof rec.methods === 'object'
      ) {
        const methods = {};
        for (const m of Object.keys(rec.methods)) {
          if (GRANTABLE_METHODS.has(m) && typeof rec.methods[m] === 'number') {
            methods[m] = rec.methods[m];
          }
        }
        if (Object.keys(methods).length > 0) out[host] = { grantedAt: rec.grantedAt, methods };
      }
    }
    return out;
  }

  async function write(grants) {
    await storage.set({ [GRANTS_KEY]: grants });
  }

  return {
    /** 'persisted' | 'session' | false */
    async check(host, method) {
      if (sessionGrants.has(`${host}|${method}`)) return 'session';
      const grants = await readRaw();
      return grants[host]?.methods?.[method] ? 'persisted' : false;
    },

    /** Persist a grant covering exactly the methods approved. */
    async grant(host, methods) {
      const list = [...new Set(methods)].filter((m) => GRANTABLE_METHODS.has(m));
      if (list.length === 0) return;
      const grants = await readRaw();
      const rec = grants[host] ?? { grantedAt: now(), methods: {} };
      for (const m of list) rec.methods[m] = now();
      grants[host] = rec;
      await write(grants);
    },

    /** A this-time-only grant — memory, dies with the worker. */
    grantSession(host, methods) {
      for (const m of methods) {
        if (GRANTABLE_METHODS.has(m)) sessionGrants.add(`${host}|${m}`);
      }
    },

    /** Revocation deletes the record immediately (a null host = all). */
    async revoke(host = null) {
      if (host === null) {
        sessionGrants.clear();
        await write({});
        return;
      }
      const grants = await readRaw();
      delete grants[host];
      await write(grants);
      for (const key of [...sessionGrants]) {
        if (key.startsWith(`${host}|`)) sessionGrants.delete(key);
      }
    },

    /** The Sites screen: every persisted grant with host, methods, date. */
    async list() {
      const grants = await readRaw();
      return Object.entries(grants).map(([host, rec]) => ({
        host,
        grantedAt: rec.grantedAt,
        methods: Object.keys(rec.methods).sort(),
      }));
    },
  };
}
