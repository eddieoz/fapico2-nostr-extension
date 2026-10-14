// US-1695 — the boot-time fix for the storage.session write block: the
// pending-request map is written by the worker (trusted) but must be
// readable for re-delivery into pages, so the access level is widened at
// the only place that can do it — the worker's boot.
export async function widenSessionAccess(chrome_ = chrome) {
  try {
    await chrome_.storage?.session?.setAccessLevel({
      accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS',
    });
  } catch {
    // No storage.session (a fresh install racing shutdown): nothing to
    // widen; re-adoption will find an empty store.
  }
}
