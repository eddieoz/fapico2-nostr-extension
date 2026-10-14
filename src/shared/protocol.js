// The page-facing protocol constants, shared (in repo source; bundled into
// each chunk) by the MAIN-world provider and the isolated-world bridge.
// The marker namespaces the postMessage channel; the allow-list is the
// narrow surface the page may call — the same five methods the dispatch
// relays, named in the worker's snake_case.

export const NOSTR_MARKER = 'fapico:nostr:1';

export const PAGE_METHODS = new Set([
  'get_public_key',
  'sign_event',
  'list_keys',
  'nip44_encrypt',
  'nip44_decrypt',
]);

// The page relay drops an oversized payload loudly rather than forwarding a
// frame the worker would refuse. The device's own wire cap is 1891 bytes
// per NIP-44 argument (§2.2.1); sign_event carries a whole event (hashed by
// the worker, not framed to the device), so the page-relay bound is set
// generously above any legitimate event — 1 MiB of JSON.
export const MAX_PAGE_PAYLOAD_CHARS = 1 << 20;

export function isPageMethod(method) {
  return typeof method === 'string' && PAGE_METHODS.has(method);
}
