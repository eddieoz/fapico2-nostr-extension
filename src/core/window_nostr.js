// US-1670 — the window.nostr bridge (design §4.1). Two halves, because the
// architecture forces the split:
//
//   - The WebHID transport only lives in the extension's **isolated world**
//     (the manifest's `hid` permission is what makes navigator.hid exist),
//     so the signer and the device stay in the isolated world.
//   - The page can only see `window.nostr` defined in the **MAIN world**
//     (an isolated-world global is invisible to page scripts), so the
//     page-visible provider is installed there, and the two halves talk
//     over same-frame postMessage.
//
// The surface is deliberately narrow — sign-and-prompt only (§4.1): npubs
// are public, so `getPublicKey`/`listKeys` are touch-free by the device's
// own design (§2.2); what the page cannot do is sign without a physical
// touch, and that is the *device's* decision, not this bridge's — the
// refusal word (0x6985) crosses untouched. Anything outside the NIP-07
// signing surface — `nip04` above all, whose ECDH shared secret this
// design refuses to produce (§A.3) — is refused with a typed UNSUPPORTED
// before the signer (and the device) is ever touched.

export const NOSTR_MARKER = 'openxrypt:nostr:1';

// Methods the page may ask for. Everything else is refused by name —
// including nip04 (§A.3) and getRelays (there is no relay pool; this
// delivers a signer, not a Nostr client, §4).
const PAGE_METHODS = {
  getPublicKey: (signer) => signer.getPublicKey(),
  signEvent: (signer, event) => signer.signEvent(event),
  listKeys: (signer) => signer.listKeys(),
};

export function serializeBridgeError(err) {
  return {
    name: err.name,
    code: err.code ?? err.name,
    sw: err.sw,
    message: String(err.message ?? err),
  };
}

export function reviveBridgeError(blob) {
  const err = new Error(blob.message);
  err.name = blob.name;
  err.code = blob.code;
  err.sw = blob.sw;
  return err;
}

/**
 * The isolated-world half: map a method name to the signer. Returns
 * `{result}` or `{error}` — never throws, because the reply crosses
 * postMessage and an uncaught rejection there is just silence for the page.
 *
 * `onSignature(signerKind)` fires after a completed signEvent — the loud
 * indicator's feed (US-1671: name which signer produced the last
 * signature). `onDeviceAbsent(deviceName)` fires when a request fails for
 * absence — the non-dismissible warning's feed. Both are observations only;
 * neither can queue or retry anything, because nothing here holds state.
 */
export function createNostrBridge({ getSigner, onSignature, onDeviceAbsent }) {
  return async function handle(method, args = []) {
    if (!Object.hasOwn(PAGE_METHODS, method)) {
      return {
        error: {
          name: 'UnsupportedMethodError',
          code: 'UNSUPPORTED',
          message:
            `nostr.${method} is not offered — the page-visible API is ` +
            'sign-and-prompt only (design §4.1)',
        },
      };
    }
    try {
      const signer = await getSigner();
      const result = await PAGE_METHODS[method](signer, ...args);
      if (method === 'signEvent' && onSignature) onSignature(signer.kind);
      return { result };
    } catch (err) {
      if (onDeviceAbsent && err?.code === 'DEVICE_ABSENT') {
        onDeviceAbsent(err.device ?? 'Fapico board');
      }
      return { error: serializeBridgeError(err) };
    }
  };
}

/**
 * The isolated-world listener: answer calls arriving from the page world
 * through the same frame. attachNostrBridge and installPageNostr ignore
 * each other's directions, so one bundle can run in both worlds (the
 * manifest loads it twice — once per world).
 */
export function attachNostrBridge(win, handler) {
  win.addEventListener('message', async (ev) => {
    // US-1684: this `ev.source !== win` check IS the isolation boundary.
    // There is no `ev.origin` check, by design, for same-frame traffic — the
    // bridge only ever answers the isolated world's own window. A future
    // cross-frame change must not silently drop this guard: it is the only
    // thing standing between the page world and this handler.
    if (ev.source !== win) return; // same frame only
    const d = ev.data;
    if (!d || d.marker !== NOSTR_MARKER || d.dir !== 'call') return;
    const reply = await handler(d.method, d.args);
    win.postMessage(
      { marker: NOSTR_MARKER, dir: 'reply', id: d.id, reply },
      win.location.origin,
    );
  });
}

/**
 * The MAIN-world half: define `window.nostr` with the narrow surface,
 * backed by same-frame postMessage. Never clobbers an existing provider —
 * whatever else the user has installed keeps the slot.
 */
export function installPageNostr(win) {
  if (win.nostr) return false;
  let seq = 0;
  const pending = new Map();
  win.addEventListener('message', (ev) => {
    if (ev.source !== win) return;
    const d = ev.data;
    if (!d || d.marker !== NOSTR_MARKER || d.dir !== 'reply') return;
    const p = pending.get(d.id);
    if (!p) return;
    pending.delete(d.id);
    if (d.reply.error) {
      p.reject(reviveBridgeError(d.reply.error));
    } else {
      p.resolve(d.reply.result);
    }
  });
  const call = (method, ...args) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      win.postMessage(
        { marker: NOSTR_MARKER, dir: 'call', id, method, args },
        win.location.origin,
      );
    });
  win.nostr = {
    getPublicKey: () => call('getPublicKey'),
    signEvent: (event) => call('signEvent', event),
    listKeys: () => call('listKeys'),
  };
  return true;
}
