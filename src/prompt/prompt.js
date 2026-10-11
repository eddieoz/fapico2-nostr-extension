// US-1700 — the approval prompt page. It renders the requesting host, the
// method in plain words, and the worker's preview (metadata only — never
// plaintext, never key material), then sends the decision back through the
// worker's trusted-only prompt_decision method. Closing the window is an
// explicit deny — the worker's windows.onRemoved handles it; this page only
// ever answers for itself.

import { createPortClient } from '../shared/port-client.js';

const api = createPortClient({ name: 'nostr-prompt' });
const $ = (id) => document.getElementById(id);

const METHOD_WORDS = {
  get_public_key: 'read the public key (npub) of your identity',
  sign_event: 'sign a Nostr event with your device key',
  list_keys: 'list the identities on your device',
  nip44_encrypt: 'encrypt a message with your device key',
  nip44_decrypt: 'decrypt a message with your device key',
};

const params = new URLSearchParams(location.search);
const requestId = params.get('request') ?? '';
const method = params.get('method') ?? '';
const host = params.get('host') ?? 'unknown site';
const preview = params.get('preview') ?? '';

$('host').textContent = host;
$('wants').innerHTML = `This site wants to <span class="what">${
  METHOD_WORDS[method] ?? method
}</span>.` + (preview ? `<br>${escapeHtml(preview)}` : '');
$('hint').textContent =
  method === 'get_public_key'
    ? 'Your npub is public — but which sites may see it is still your call.'
    : 'Nothing is signed, encrypted or decrypted until you approve.';

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
