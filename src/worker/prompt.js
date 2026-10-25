// US-1700 — the approval prompt window: context before the touch. For an
// ungranted (host, method) request the worker opens a popup window
// (chrome.windows.create, type popup) that renders the requesting host, the
// method in plain words, and a preview — for signEvent the event kind and a
// one-line content summary; for nip44 the peer and the payload length,
// never the plaintext. Approve resolves the request (optionally persisting
// per US-1699); Deny or closing the window rejects it `user-denied`. The
// device is invoked only after approval — the consent gate sits before the
// device call in the handler path.
//
// Window close is an explicit reject: chrome.windows.onRemoved fires for a
// prompt window whose id is outstanding, and the promise rejects typed —
// the Flamingo hang bug, fixed at the only place that can fix it.

import { USER_DENIED } from './errors.js';

/** The kind→action map (the Flamingo pattern, original implementation). */
export const EVENT_KIND_WORDS = {
  0: 'metadata update',
  1: 'short text note',
  3: 'contact list',
  4: 'encrypted direct message',
  5: 'event deletion',
  6: 'repost',
  7: 'reaction',
  40: 'channel creation',
  41: 'channel metadata',
  42: 'channel message',
  22242: 'authentication of a client',
  10002: 'relay list metadata',
  30023: 'long-form article',
  30078: 'application-specific data',
};

function truncate(s, n = 80) {
  const oneLine = String(s).replace(/\s+/g, ' ').trim();
  return oneLine.length > n ? `${oneLine.slice(0, n - 1)}…` : oneLine;
}

/**
 * The preview string the prompt renders — metadata only, never the
 * plaintext of a decrypt and never key material.
 */
export function buildPreview(method, args = []) {
  switch (method) {
    case 'get_public_key':
      return 'reads the public key (npub) of the selected identity';
    case 'list_keys':
      return 'lists the identities stored on the device';
    case 'sign_event': {
      const e = args[0] ?? {};
      const kind = Number.isInteger(e.kind) ? e.kind : Number(e.kind);
      const what = EVENT_KIND_WORDS[kind] ?? `kind ${e.kind}`;
      const content = e.content ? ` — "${truncate(e.content)}"` : '';
      return `signs a ${what}${content}`;
    }
    case 'nip44_encrypt': {
      const peer = typeof args[0] === 'string' ? `${args[0].slice(0, 12)}…` : '?';
      const len = typeof args[1] === 'string' ? args[1].length / 2 : 0;
      return `encrypts ${Math.round(len)} byte(s) for peer ${peer}`;
    }
    case 'nip44_decrypt': {
      const peer = typeof args[0] === 'string' ? `${args[0].slice(0, 12)}…` : '?';
      const len = typeof args[1] === 'string' ? Math.floor((args[1].length * 3) / 4) : 0;
      return `decrypts a ${Math.round(len)} byte(s) payload from peer ${peer} — the text stays on your device`;
    }
    default:
      return '';
  }
}

/**
 * The prompt orchestration. `windows` is a chrome.windows-shaped double:
 * `{ create(opts) -> {id}, onRemoved: {addListener(fn)}, remove(id) }`.
 * Decisions arrive from the prompt page through the dispatch (`prompt_decision`).
 *
 * A request lives in one of two maps. `outstanding` holds the pre-approve
 * record (a window close there is an explicit deny). Once approved, `decide`
 * moves it to `awaitingSettle` (kept, with its windowId): the consent promise
 * has already resolved exactly once and the handler path is unchanged, but the
 * record must survive so a post-approval window close is a no-op (US-1722) and
 * US-1723's settle() can push the outcome and drop it.
 */
export function createPromptFlow({
  windows,
  now = () => Date.now(),
  // US-1723 — push a frame to the bound port of a request's window. Keyed by
  // requestId: the prompt port's name is `nostr-prompt-<requestId>`, so the
  // worker binds requestId -> port on connect, resolved without a persisted
  // field. Defaults to a no-op so callers that never settle are unaffected.
  deliver = () => {},
  // US-1723 — how long (ms) the outcome beat stays visible before the window
  // closes.
  beatMs = 800,
} = {}) {
  const outstanding = new Map(); // requestId -> {resolve, reject, windowId, lineDone}
  const awaitingSettle = new Map(); // requestId -> {windowId, lineDone}

  // US-1725 — the consent line: exactly one prompt window at a time. A fresh
  // install has no grants and a site fires several ungranted calls at once;
  // every one of them used to open its OWN window — a popup storm where each
  // approved op then queued behind the others for the single device (the
  // chat.nostr.com reinstall field report). The line releases when a request
  // is fully done: its device op settled (ok or err), or its ask rejected
  // (deny / window closed). Consent is never weakened — every request still
  // gets its own window and its own decision, in order.
  let consentLine = Promise.resolve();

  if (windows?.onRemoved?.addListener) {
    windows.onRemoved.addListener((windowId) => {
      for (const [id, rec] of [...outstanding.entries()]) {
        if (rec.windowId !== windowId) continue;
        outstanding.delete(id);
        // Closing the window BEFORE approval is an explicit reject — never a
        // hang. A window closed AFTER approval lives in awaitingSettle, so it
        // is not touched here (US-1722 — post-approval close is a no-op).
        rec.lineDone?.();
        rec.reject({ ...USER_DENIED, message: 'the approval window was closed — request denied' });
      }
    });
  }

  return {
    /** Open the prompt; resolves `{approved, remember}` or rejects typed.
     *  Waits for the previous request's line slot — one window at a time. */
    async ask({ requestId, method, host, preview, focus = true }) {
      const prev = consentLine;
      let lineDone;
      consentLine = new Promise((r) => (lineDone = r));
      let entered = false;
      try {
        await prev; // the line is never rejected; it is only released
        entered = true;
        const url =
          `prompt.html?request=${encodeURIComponent(requestId)}` +
          `&method=${encodeURIComponent(method)}` +
          `&host=${encodeURIComponent(host)}` +
          `&preview=${encodeURIComponent(preview)}`;
        const win = await windows.create({
          url,
          type: 'popup',
          width: 420,
          height: 320,
          focused: focus,
        });
        return new Promise((resolve, reject) => {
          outstanding.set(requestId, { resolve, reject, windowId: win.id, lineDone });
        });
      } catch (err) {
        if (!entered) lineDone(); // never hold the line for a failure to enter it
        throw err;
      }
    },

    /** The prompt page's decision (via the dispatch, trusted sender). */
    async decide({ requestId, approve, remember = false }) {
      const rec = outstanding.get(requestId);
      if (!rec) return { delivered: false };
      outstanding.delete(requestId);
      if (approve) {
        // US-1722 — resolve exactly once (handler path unchanged), but keep the
        // record in awaitingSettle with its windowId so a post-approval close is
        // a no-op and US-1723 can settle it. The line is NOT released here: the
        // next window opens only after this request's device op settles.
        awaitingSettle.set(requestId, { windowId: rec.windowId, lineDone: rec.lineDone });
        rec.resolve({ approved: true, remember, at: now() });
      } else {
        rec.lineDone?.(); // a denial is final — the line moves on now
        rec.reject({ ...USER_DENIED });
      }
      return { delivered: true };
    },

    /**
     * US-1723 — the device op settled (`outcome` is 'ok' or 'err'). Push the
     * outcome to the request's window port and, after a visible beat, close it
     * — but only on success. An error keeps the window open with its typed
     * sentence: the chat.nostr.com field run showed an 800 ms flash is not
     * readable, and the sentence IS the diagnosis (which word the board
     * answered). The user closes an error window themselves. A settle for an
     * unknown requestId (a worker restart ate the map) is inert — no throw,
     * no store write, no resurrection of state: awaitingSettle is in-memory
     * only, so the session-record shape gains no field.
     */
    async settle(requestId, outcome, message) {
      const rec = awaitingSettle.get(requestId);
      if (!rec) return { delivered: false };
      awaitingSettle.delete(requestId);
      deliver(requestId, {
        event: 'prompt-settled',
        requestId,
        outcome,
        // US-1723 — the typed error sentence (e.g. the 6985 touch timeout)
        // rides along for 'err'; 'ok' carries none.
        ...(message != null ? { message } : {}),
      });
      // The request is fully done — the line moves on (the error WINDOW may
      // stay open for its sentence; the line is not the window).
      rec.lineDone?.();
      // A visible beat so the user sees the outcome before the window closes.
      // windows.remove on an already-closed window is swallowed (US-1722).
      if (outcome !== 'err') {
        setTimeout(() => {
          windows.remove(rec.windowId).catch(() => {});
        }, beatMs);
      }
      return { delivered: true };
    },

    /** Approved-but-not-yet-settled requests (US-1722). */
    get awaitingSettleCount() {
      return awaitingSettle.size;
    },

    get outstandingCount() {
      return outstanding.size;
    },
  };
}
