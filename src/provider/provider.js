// US-1696/US-1697 — the MAIN-world provider. Injected by the bridge as a
// <script src> tag from web_accessible_resources (the Flamingo pattern —
// the same-file-two-worlds manifest entry is what kills NIP-07 on Chrome
// 154, verified live 2026-10-11; this chunk is the only web-accessible
// resource and the manifest declares no world: "MAIN").
//
// The surface is the NIP-07 trio plus the device NIP-44 pair:
//   getPublicKey(), signEvent(event), listKeys(),
//   nip44.encrypt(peer, plaintext), nip44.decrypt(sender, payload)
// Every call posts {marker, dir:'call', id, method, args, host} and parks a
// promise in the per-request map; replies with dir:'reply' resolve or
// reject it, with the typed error's name revived across the postMessage
// boundary. No promise timeout — the device may take seconds (a touch is
// the consent boundary).
//
// Never clobbers an existing provider: whatever else the user has
// installed keeps the slot.

import { serializeBridgeError, reviveBridgeError } from '../core/window_nostr.js';
import { NOSTR_MARKER } from '../shared/protocol.js';

const utf8 = new TextEncoder();
const decoder = new TextDecoder();

function utf8ToHex(s) {
  return [...utf8.encode(s)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToUtf8(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return decoder.decode(bytes);
}

/**
 * Install `window.nostr`. Returns false when a provider already holds the
 * slot (never-clobber). `win` is the page's window.
 */
export function installProvider(win) {
  if (win.nostr) return false;
  let seq = 0;
  const pending = new Map();

  win.addEventListener('message', (ev) => {
    // Same frame only, and only our marker's reply direction.
    if (ev.source !== win) return;
    const d = ev.data;
    if (!d || d.marker !== NOSTR_MARKER || d.dir !== 'reply') return;
    const p = pending.get(d.id);
    if (!p) return;
    pending.delete(d.id);
    if (d.reply?.error) p.reject(reviveBridgeError(d.reply.error));
    else p.resolve(d.reply?.result);
  });

  const call = (method, ...args) =>
    new Promise((resolve, reject) => {
      const id = `p${seq++}`;
      pending.set(id, { resolve, reject });
      win.postMessage(
        { marker: NOSTR_MARKER, dir: 'call', id, method, args, host: win.location.host },
        win.location.origin,
      );
    });

  win.nostr = {
    getPublicKey: () => call('get_public_key'),
    signEvent: (event) => call('sign_event', event),
    listKeys: () => call('list_keys'),
    nip44: {
      // NIP-44's plaintext is utf8 text; it crosses as hex so the frame
      // stays JSON-serializable. The worker does the device framing.
      encrypt: (peer, plaintext) => call('nip44_encrypt', peer, utf8ToHex(String(plaintext))),
      decrypt: (sender, payload) =>
        call('nip44_decrypt', sender, payload).then((hex) => hexToUtf8(hex)),
    },
  };
  return true;
}

// Entry: this chunk is only ever loaded as the injected provider.
if (typeof window !== 'undefined') {
  installProvider(window);
}
