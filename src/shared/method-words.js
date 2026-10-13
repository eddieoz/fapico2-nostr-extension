// US-1731 — one vocabulary for the methods a page may be granted. The worker
// (buildPreview), the prompt, and the Sites screen each rendered these method
// names their own way — snake_case identifiers, raw method names — so the same
// grant read three different ways. This module is the single canonical map:
// the method name the worker relays → the plain words every surface shows.
// buildPreview keeps its request-specific sentences (D-UX9 makes the *vocabulary*
// canonical, not the sentences); this is the vocabulary.

/**
 * The canonical method → plain-words map. Keyed by the exact method name the
 * worker relays (snake_case, matching PAGE_METHODS / GRANTABLE_METHODS), so
 * every surface — the prompt, the Sites screen, anything future — consumes the
 * same words instead of re-deriving them.
 */
export const METHOD_WORDS = {
  get_public_key: 'reads your public key',
  sign_event: 'signs events',
  list_keys: 'lists your identities',
  nip44_encrypt: 'encrypts for a peer',
  nip44_decrypt: 'decrypts from a peer',
};

/**
 * The plain words for one granted method. An unknown method falls back to its
 * raw name so a grant for a method added later never renders blank.
 */
export function methodWord(method) {
  return METHOD_WORDS[method] ?? method;
}

/**
 * The plain words for a grant's methods, joined as a page reads them — e.g.
 * `methodWords(['get_public_key', 'sign_event'])` → `'reads your public key,
 * signs events'`. Accepts a single method or a list.
 */
export function methodWords(methods) {
  const list = Array.isArray(methods) ? methods : [methods];
  return list.map(methodWord).join(', ');
}
