// US-1700 — the approval prompt page. It renders the requesting host, the
// worker's preview (metadata only — never plaintext, never key material) as
// the request headline with the raw method as a chip, then sends the decision
// back through the worker's trusted-only prompt_decision method. Closing the
// window is an explicit deny — the worker's windows.onRemoved handles it; this
// page only ever answers for itself.

import { createPortClient } from '../shared/port-client.js';
import { identityLine } from './identity.js';
import { requestRender } from './request-render.js';
import { rememberCopy } from './remember-copy.js';
import { TOUCH_TEXT, LOST_CONNECTION_TEXT, settleBeat } from './touch-state.js';

const $ = (id) => document.getElementById(id);

const params = new URLSearchParams(location.search);
const requestId = params.get('request') ?? '';
const method = params.get('method') ?? '';
const host = params.get('host') ?? 'unknown site';
const preview = params.get('preview') ?? '';

// US-1723 — the prompt port is bound to this request (its name carries the
// requestId), so the worker can push the prompt-settled outcome frame back to
// exactly this window.
const api = createPortClient({ name: `nostr-prompt-${requestId}` });

$('host').textContent = host;
$('remember-note').textContent = rememberCopy(host);
const render = requestRender(preview, method);
$('method-chip').textContent = render.chip;
// US-1738 — verbatim: the sink is textContent (safe by construction). The
// escaping wrapper was load-bearing for the old innerHTML sink and only
// double-escaped previews containing & < > " around the new one.
$('headline').textContent = render.headline;
$('hint').textContent =
  method === 'get_public_key'
    ? 'Your npub is public — but which sites may see it is still your call.'
    : 'Nothing is signed, encrypted or decrypted until you approve.';

// US-1710 — the identity line: which key will answer. Fetched at open —
// the consent gate precedes the handler, so no device op is queued while
// this runs, and both fetches are touch-free. Degradation is graded and
// silent: only the slot known → the slot-only line; even the slot read
// failed (device absent, BAD_SLOT, port trouble) → the line is omitted.
// Never an error dialog: the line is advisory context, the device touch
// is the consent.
const withTimeout = (p, ms) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), ms))]);

if (method !== 'list_keys') {
  (async () => {
    try {
      const slot = (await withTimeout(api.call('get_active_slot'), 1500))?.slot;
      let keys = null;
      try {
        keys = await withTimeout(api.call('list_keys'), 1500);
      } catch { /* graded: slot-only */ }
      const line = identityLine(slot, keys);
      if (line) {
        $('identity').textContent = line;
        $('identity').hidden = false;
      }
    } catch { /* graded: omit — the line is advisory, never an error */ }
  })();
}

// US-1724 — the post-approve states. After Approve the page flips to the touch
// state (the amber bar); the worker owns the outcome beat and the close. On the
// prompt-settled push it shows the outcome (success beat, or the typed error
// sentence verbatim) and lets the window close; on disconnect it shows the
// lost-connection notice. A terminal state is shown once — a late disconnect
// after a settle, or a second frame, is ignored.
const touchBar = $('touch-bar');
const outcome = $('outcome');
let done = false;
const once = (fn) => (...args) => {
  if (done) return;
  done = true;
  fn(...args);
};

const showOutcome = once((beat) => {
  touchBar.hidden = true;
  touchBar.classList.remove('on');
  outcome.hidden = false;
  outcome.textContent = beat.text;
  outcome.className = `outcome${beat.err ? ' err' : ''}`;
});

const showLostConnection = once(() => {
  touchBar.hidden = true;
  touchBar.classList.remove('on');
  outcome.hidden = false;
  outcome.textContent = LOST_CONNECTION_TEXT;
  outcome.className = 'outcome err';
});

function showTouch() {
  touchBar.hidden = false;
  touchBar.classList.add('on');
  $('touch-text').textContent = TOUCH_TEXT;
  $('actions').hidden = true;
}

// US-1723 — the worker pushes the outcome frame to this request's port.
api.onEvent((frame) => {
  if (frame.event !== 'prompt-settled') return;
  showOutcome(settleBeat(method, frame));
  // The worker closes the window after a beat (US-1723); this is the page's own
  // guarantee that the beat stays visible even if that remove never lands.
  setTimeout(() => window.close(), 800);
});

api.onDisconnect(() => {
  if (done) return; // a settle already reached us — nothing to recover
  showLostConnection();
});
$('approve').addEventListener('click', () => {
  api
    .call('prompt_decision', {
      requestId,
      approve: true,
      remember: $('remember').checked,
    })
    // US-1724 — approval resolves the consent; the window STAYS OPEN through
    // the device touch (D-UX6). The worker closes it after the outcome beat.
    .then(showTouch)
    .catch(showLostConnection);
});

$('deny').addEventListener('click', () => {
  api
    .call('prompt_decision', { requestId, approve: false })
    .finally(() => window.close());
});
