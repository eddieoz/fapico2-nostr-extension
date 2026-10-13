// US-1736 — the prompt-port registry. A prompt window's port is named
// `nostr-prompt-<requestId>` (composite requestIds included — US-1735), so
// the worker binds it on connect and US-1723's settle() pushes the outcome
// frame to exactly that request's window. Three facts live here, pure:
//   bind(port)  — registers the port under the captured requestId (or null
//                 for a non-prompt port);
//   drop(port)  — forgets it on disconnect (a closed prompt window never
//                 accumulates in the worker's map);
//   deliver(id, frame) — posts to the bound port, swallowing the throw a
//                 disconnected port produces (the settle's own outcome is
//                 already recorded; a dead port must not break the close).
const PROMPT_PORT_NAME = /^nostr-prompt-(.+)$/;

export function createPromptPortRegistry() {
  const byKey = new Map(); // requestId -> port
  const keyOf = new Map(); // port -> requestId

  return {
    /** Bind one connecting port. Returns the captured requestId or null. */
    bind(port) {
      const match = PROMPT_PORT_NAME.exec(port?.name ?? '');
      if (!match) return null;
      const key = match[1];
      // A reconnecting prompt page rebinds under the same requestId — the
      // newest port wins (the old one is dead or dying).
      const previous = keyOf.get(port);
      if (previous && previous !== key) byKey.delete(previous);
      byKey.set(key, port);
      keyOf.set(port, key);
      return key;
    },

    /** Forget one port's binding (idempotent). */
    drop(port) {
      const key = keyOf.get(port);
      if (key === undefined) return;
      keyOf.delete(port);
      if (byKey.get(key) === port) byKey.delete(key);
    },

    /**
     * Push a frame to the port bound to `requestId`. Returns false when no
     * live port is bound (unknown key, dropped, or the post threw).
     */
    deliver(requestId, frame) {
      const port = requestId == null ? null : byKey.get(requestId);
      if (!port) return false;
      try {
        port.postMessage(frame);
        return true;
      } catch {
        return false;
      }
    },
  };
}
