// US-1702 addendum — the connect tab. Chromium cancels a WebHID chooser
// anchored to the action popup (the dialog steals focus, the popup closes on
// blur, the request dies with it) and also to popup-type windows (the
// chooser bubble closes itself, kLostFocus, within a second). So the Connect
// button in the popup opens THIS page in a real tab, where the chooser
// anchors and stays. The rules are unchanged: the chooser runs here, in an
// extension page, under a click gesture; the worker never opens a chooser;
// the granted device is adopted by pair_device.

import { createPortClient } from '../shared/port-client.js';
import { createPairing } from './pairing.js';

/** Close this page whether it runs as a tab (chrome.tabs) or a window. */
function closeSelf() {
  try {
    chrome.tabs.getCurrent((tab) => {
      if (tab) chrome.tabs.remove(tab.id);
      else window.close();
    });
  } catch {
    window.close();
  }
}

/**
 * The window's flow, separated from the DOM so tests can drive it.
 * Returns the device-card state; `onClose` fires after a connected result
 * (a beat, so the green state is seen, then the window dismisses itself).
 */
export function createConnectFlow({ requestDevice, call, persist = () => {}, onClose = () => {}, autoCloseMs = 1500, busyRetryMs = 1100 }) {
  const pairing = createPairing({ requestDevice, call, persist });
  let closed = false;

  // US-1714 — touch-free key count for the handoff. A rejection returns null so
  // the caller (handoffDecision) closes rather than hangs; never block a
  // successful pair on a listing error.
  async function listKeyCount() {
    try {
      const keys = await call('list_keys');
      return Array.isArray(keys) ? keys.length : 0;
    } catch {
      return null;
    }
  }

  return {
    /** The Connect click — runs the chooser in this gesture. */
    async connect() {
      try {
        const health = await pairing.connect();
        if (health.state === 'connected' && !closed) {
          // US-1714 — first-run handoff: a freshly paired board with zero keys
          // stays open (points at the toolbar icon) so the journey doesn't
          // silently end; a returning board, or a listing that failed, closes
          // after the beat.
          if (handoffDecision(await listKeyCount()).handoff) {
            return { ...health, handoff: true };
          }
          closed = true;
          setTimeout(onClose, autoCloseMs);
        }
        return health;
      } catch (err) {
        // A dismissed chooser is a retryable refusal here — the window stays
        // up so the user can click Connect again (the action popup died on
        // blur; this window does not).
        if (err?.name === 'NotFoundError') return { state: 'absent', cancelled: true };
        throw err;
      }
    },

    /**
     * Touch-free probe for boot — a reopened window shows the live truth.
     * A `busy` answer is the worker's 1 s probe window (the popup's own boot
     * probe fired moments before this window opened), not a fault: one retry
     * after the window lapses, exactly like the popup's boot path.
     */
    async health(opts) {
      let h = await pairing.health(opts);
      if (h?.state === 'busy') {
        await new Promise((r) => setTimeout(r, busyRetryMs));
        h = await pairing.health({ ...opts, force: true });
      }
      return h;
    },

    get lastHealth() {
      return pairing.lastHealth;
    },
  };
}

// US-1714 — first-run handoff decision. A freshly paired board with zero keys
// stays open (the journey otherwise silently ends); a returning board — or one
// whose key listing failed (`keyCount` is null) — closes after the beat so a
// successful pair never leaves the window hung.
export function handoffDecision(keyCount) {
  if (keyCount == null) return { close: true, handoff: false };
  return { close: keyCount > 0, handoff: keyCount === 0 };
}

// US-1713 — the connect page's named states, as a pure mapping so each state's
// copy and treatment is testable without a DOM. `error` is distinct from
// `absent`: a granted-but-failing board says "device error — <why>", never the
// absent line "no board granted yet". `idle` (the pre-boot page) reads the
// same honest line as `absent`. `waiting`/`cancelled` are event-driven (the
// Connect click) and stay in the DOM glue.
export function connectStateLabel(state, message) {
  switch (state) {
    case 'connected':
      return { line: 'fapico2 board connected', dot: 'connected', lineClass: 'connect-state connected' };
    case 'busy':
      return { line: 'busy — retrying in a second', dot: 'busy', lineClass: 'connect-state waiting' };
    case 'error':
      return { line: `device error — ${message ?? 'try again'}`, dot: 'error', lineClass: 'connect-state error' };
    case 'idle':
    case 'absent':
    default:
      return { line: 'no board granted yet', dot: 'absent', lineClass: 'connect-state' };
  }
}

// --- DOM glue (built page only) ------------------------------------------------

if (typeof document !== 'undefined' && document.getElementById('connect')) {
  const api = createPortClient();
  const $ = (id) => document.getElementById(id);

  const flow = createConnectFlow({
    requestDevice: (opts) => navigator.hid.requestDevice(opts),
    call: api.call,
    persist: (h) => {
      try {
        chrome.storage.session.set({ nostrDeviceCard: h });
      } catch { /* no session storage — the popup's fresh check decides */ }
    },
    onClose: closeSelf,
  });

  function notice(msg, cls = '') {
    const el = $('notice');
    el.hidden = !msg;
    el.textContent = msg ?? '';
    el.className = `notice ${cls}`;
  }

  function setDot(stateName) {
    const dot = $('device-dot');
    dot.className = stateName;
    dot.textContent =
      stateName === 'connected' ? 'connected' :
      stateName === 'absent' ? 'not present' :
      stateName === 'busy' ? 'busy' :
      stateName === 'error' ? 'error' : 'checking';
  }

  // US-1713 — one render path, driven by the pure state map, so the five
  // states can never drift apart again.
  function render(h) {
    if (!h) return;
    // US-1714 — freshly paired with zero keys: stay open, point at the toolbar
    // icon (the actual next action), rather than auto-closing the journey.
    if (h.handoff) {
      setDot('connected');
      const el = $('connect-state');
      el.textContent = 'connected — open the fapico2 toolbar icon to create your first key';
      el.className = 'connect-state connected';
      return;
    }
    const { line, dot, lineClass } = connectStateLabel(h.state, h.message);
    setDot(dot);
    const el = $('connect-state');
    el.textContent = line;
    el.className = lineClass;
  }

  $('connect').addEventListener('click', async () => {
    if (!navigator.hid) {
      notice('WebHID is not available in this browser', 'err');
      return;
    }
    $('connect').disabled = true;
    $('connect-state').textContent = 'waiting for the picker…';
    $('connect-state').className = 'connect-state waiting';
    notice('');
    try {
      const health = await flow.connect();
      render(health);
      if (health.cancelled) {
        notice('no device selected — click Connect to try again', 'err');
      } else if (health.state !== 'connected') {
        notice(health.message ?? 'pairing failed', 'err');
      }
    } catch (err) {
      notice(err.message ?? 'the chooser failed', 'err');
    } finally {
      $('connect').disabled = false;
    }
  });

  (async function boot() {
    const h = await flow.health({ force: true });
    render(h);
    if (h.state === 'connected') {
      // Already granted — show it, then dismiss; nothing to choose.
      setTimeout(closeSelf, 1500);
    }
  })();
}
