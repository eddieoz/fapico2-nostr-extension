// US-1724 — the prompt page's post-approve states, as pure text so the DOM
// page (prompt.js) stays a thin driver and the copy is testable without jsdom.
// No key material or plaintext ever renders here — only short status labels.

/** The amber touch bar: the physical press is the final consent. */
export const TOUCH_TEXT = 'touch your fapico2 board';

/**
 * The pre-approval advisory for a PIN-locked board (the chat.nostr.com field
 * run). The custody board refuses sign/nip44 ops with 0x6982 while locked —
 * pre-touch, so the device never arms and the user waits at an amber bar for
 * nothing. Shown at prompt open for the gated methods when GET_INFO says a
 * PIN is set and the session is not unlocked: unlock FIRST, then approve.
 */
export const PIN_LOCKED_ADVISORY =
  'this board is locked with a PIN — open the fapico2 popup and verify it before approving; the operation will not run while it is locked.';

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
