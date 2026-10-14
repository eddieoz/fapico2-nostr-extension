// US-1724 — the prompt page's post-approve states, as pure text so the DOM
// page (prompt.js) stays a thin driver and the copy is testable without jsdom.
// No key material or plaintext ever renders here — only short status labels.

/** The amber touch bar: the physical press is the final consent. */
export const TOUCH_TEXT = 'touch your fapico2 board';

/**
 * The worker-restart case the flow cannot settle: the port dies before a
 * prompt-settled frame lands, so the page shows this and leaves the window
 * open for the user to check the site.
 */
export const LOST_CONNECTION_TEXT =
  'connection to the extension was lost — check the site';

/** The success outcome beat — a short, method-aware confirmation. */
export function successBeat(method) {
  switch (String(method ?? '').toLowerCase()) {
    case 'sign_event':
      return 'signed.';
    case 'get_public_key':
      return 'shown.';
    case 'nip44_encrypt':
      return 'encrypted.';
    case 'nip44_decrypt':
      return 'decrypted.';
    case 'list_keys':
      return 'listed.';
    default:
      return 'done.';
  }
}

/**
 * What the outcome beat shows when the device op settled (`US-1723`'s
 * `prompt-settled` frame). `err` renders the typed error sentence VERBATIM —
 * loud, never a generic "failed"; anything else is a short, method-aware
 * confirmation. The message rides the settle push unchanged.
 */
export function settleBeat(method, { outcome, message } = {}) {
  if (outcome === 'err') {
    return { text: String(message ?? ''), err: true };
  }
  return { text: successBeat(method), err: false };
}
