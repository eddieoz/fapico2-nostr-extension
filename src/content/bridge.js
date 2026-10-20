// US-1696/US-1698 — the isolated-world bridge. Two jobs, both stateless:
//
//  1. Inject the provider chunk (US-1696): a <script src> tag pointing at
//     the web_accessible_resources provider.js, appended once per page, at
//     document_start — before the page's own scripts run.
//  2. Relay (US-1698): page postMessage with the marker ⇄ the worker port.
//     Only the five page-allowed methods cross; anything else, a foreign
//     marker, a cross-origin source, or an oversized payload is dropped
//     loudly (console.warn; a forbidden-method reply for known-marker
//     traffic, silence for foreign markers).
//
// The same-frame guard `ev.source !== win` survives the port (the OpenXrypt
// US-1684 isolation boundary): the bridge only ever answers its own frame.
// The port opens lazily on the first page call, under a stable
// `nostr-<seq>` name, and reconnects on worker restart (US-1695's
// re-delivery rides the same name).

import { NOSTR_MARKER, isPageMethod, MAX_PAGE_PAYLOAD_CHARS } from '../shared/protocol.js';
import { serializeBridgeError } from '../core/window_nostr.js';

const PROVIDER_TAG_FLAG = 'data-fapico-nostr-provider';

/**
 * US-1696 — inject the provider as a script tag. Idempotent: exactly one
 * tag per page, and never when a provider already holds the slot (the
 * never-clobber rule decides who is first, before any tag is added).
 */
export function injectProvider(win, { url } = {}) {
  if (win.nostr) return null; // an existing provider keeps the slot
  const doc = win.document;
  if (doc.querySelector(`script[${PROVIDER_TAG_FLAG}]`)) {
    return doc.querySelector(`script[${PROVIDER_TAG_FLAG}]`);
  }
  const script = doc.createElement('script');
  script.src = url;
  script.setAttribute(PROVIDER_TAG_FLAG, 'true');
  (doc.head ?? doc.documentElement).appendChild(script);
  return script;
}

/**
 * US-1698 — the relay. `connect` opens (or reopens) the worker port —
 * `(name) => Port` with `{postMessage, onMessage, onDisconnect}`. Returns
 * the message handler to attach to the frame's 'message' events.
 */
export function createBridgeRelay({ win, connect, warn = console.warn, channel = new MessageChannel() }) {
  let port = null;
  let seq = 0;
  const portName = `nostr-${Math.floor(Math.random() * 1e9).toString(36)}`;
  // US-1749 — the reply channel: a dedicated MessageChannel the page never
  // receives. The bridge keeps port1 and sends every reply over it; the
  // provider claims port2 through the one-time handshake below. A page-forged
  // window reply is ignored because the page never got port2 (unless it claimed
  // it during the handshake — the honest limit, R-4). `channel` is injectable
  // so tests can inspect port2 and close the ports (open ports keep Node alive).
  let handshakeSent = false;

  function ensurePort() {
    if (port) return port;
    port = connect(portName);
    port.onMessage.addListener((msg) => {
      if (!msg || typeof msg.id === 'undefined') return;
      const reply = msg.error ? { error: msg.error } : { result: msg.result };
      // The reply crosses the port, not the window: the provider reads it on
      // port2, which the page never received.
      channel.port1.postMessage({ id: msg.id, reply });
    });
    port.onDisconnect.addListener(() => {
      // The worker restarted (US-1695): the next page call reopens the port
      // under the same name and the re-delivery arrives there.
      port = null;
    });
    return port;
  }

  return function relay(ev) {
    if (ev.source !== win) return; // same frame only — the isolation boundary
    const d = ev.data;
    if (!d || d.marker !== NOSTR_MARKER) return; // foreign marker: silence
    // US-1749 — the one-time handshake: hand the provider the reply port.
    // Answered BEFORE the call check, or init is dropped and every call hangs
    // (the provider has no timeout). One-time: a forged second init is ignored
    // (port2 is already transferred).
    if (d.dir === 'init') {
      if (handshakeSent) return;
      handshakeSent = true;
      win.postMessage(
        { marker: NOSTR_MARKER, dir: 'handshake', port: channel.port2 },
        win.location.origin,
        [channel.port2],
      );
      return;
    }
    if (d.dir !== 'call') return;
    const { id, method, args = [] } = d;

    if (!isPageMethod(method)) {
      warn(`fapico2 nostr: relayed method "${method}" refused — not in the page allow-list`);
      win.postMessage(
        {
          marker: NOSTR_MARKER,
          dir: 'reply',
          id,
          reply: {
            error: { name: 'ForbiddenMethodError', code: 'forbidden-method', message: `${method} is not offered to pages` },
          },
        },
        win.location.origin,
      );
      return;
    }
    try {
      if (JSON.stringify(d).length > MAX_PAGE_PAYLOAD_CHARS) {
        warn('fapico2 nostr: oversized relay payload dropped');
        win.postMessage(
          {
            marker: NOSTR_MARKER,
            dir: 'reply',
            id,
            reply: {
              error: { name: 'PayloadTooLargeError', code: 'payload-too-large', message: 'the relay refuses oversized payloads' },
            },
          },
          win.location.origin,
        );
        return;
      }
    } catch {
      warn('fapico2 nostr: unserializable relay payload dropped');
      return;
    }
    const p = ensurePort();
    p.postMessage({ id, method, args, host: d.host });
    seq++;
  };
}

// Entry: isolated world only (chrome.runtime exists here; MAIN world sees
// no chrome). Inject the provider, then relay.
export function initBridge({
  win = window,
  chrome_ = typeof chrome !== 'undefined' ? chrome : undefined,
} = {}) {
  if (!chrome_?.runtime?.id) return false;
  injectProvider(win, { url: chrome_.runtime.getURL('provider.js') });
  win.addEventListener('message', createBridgeRelay({ win, connect: (name) => chrome_.runtime.connect({ name }) }));
  return true;
}

if (typeof window !== 'undefined' && typeof chrome !== 'undefined' && chrome.runtime?.id) {
  initBridge();
}
