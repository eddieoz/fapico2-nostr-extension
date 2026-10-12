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

const api = createPortClient({ name: 'nostr-prompt' });
const $ = (id) => document.getElementById(id);

const params = new URLSearchParams(location.search);
const requestId = params.get('request') ?? '';
const method = params.get('method') ?? '';
const host = params.get('host') ?? 'unknown site';
const preview = params.get('preview') ?? '';

$('host').textContent = host;
$('remember-note').textContent = rememberCopy(host);
const render = requestRender(preview, method);
$('method-chip').textContent = render.chip;
$('headline').textContent = escapeHtml(render.headline);
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

$('approve').addEventListener('click', () => {
  api
    .call('prompt_decision', {
      requestId,
      approve: true,
      remember: $('remember').checked,
    })
    .finally(() => window.close());
});

$('deny').addEventListener('click', () => {
  api
    .call('prompt_decision', { requestId, approve: false })
    .finally(() => window.close());
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
