// The popup: pairing (US-1702), key management (US-1703..1706) and the
// Sites revocation screen (US-1701). An extension page — a trusted sender —
// so nothing here prompts for site consent; the device touch is the consent
// for every mutating op and the touch bar (the amber bar) surfaces it.
//
// The Connect button is the product's ONLY chooser: navigator.hid
// .requestDevice runs here, in a user-gesture context, and the worker is
// told to re-adopt the granted device (pair_device) — the worker itself
// never opens a chooser.

import { createPortClient } from '../shared/port-client.js';
import { bech32 } from '@scure/base';
import { createPairing } from './pairing.js';
import {
  renderKeysModel,
  decodeImportSecret,
  validateLabel,
  npubBech32,
  SW_WORDS,
  SLOTS,
} from './keys.js';

const api = createPortClient();
const $ = (id) => document.getElementById(id);

const state = {
  keys: [],
  deviceState: 'checking',
  lastHealthAt: 0,
  genSlot: null,
  import: null, // {scalarHex, npubHex}
  deleteTarget: null, // {idx, npub, label}
  labelTarget: null,
  exportTarget: null,
  lastHealth: null, // persisted to storage.session so reopen is truthful
};

// --- helpers -----------------------------------------------------------------

function show(screen) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  $(`screen-${screen}`)?.classList.add('active');
  $('nav-keys').classList.toggle('active', screen === 'keys');
  $('nav-sites').classList.toggle('active', screen === 'sites');
}

function notice(msg, cls = '') {
  const el = $('notice');
  el.hidden = !msg;
  el.textContent = msg ?? '';
  el.className = `notice ${cls}`;
}

function touch(on, text = 'touch your device') {
  $('touch-bar').classList.toggle('on', on);
  $('touch-text').textContent = text;
}

/** Every device call runs behind the touch bar when it is touch-gated. */
async function deviceCall(method, ...args) {
  const TOUCH_GATED = new Set(['sign_event', 'generate_key', 'import_key', 'delete_key', 'set_label', 'export_key', 'nip44_encrypt', 'nip44_decrypt']);
  const gated = TOUCH_GATED.has(method);
  if (gated) touch(true);
  try {
    return await api.call(method, ...args);
  } catch (err) {
    const word = err.sw !== undefined ? SW_WORDS[err.sw] : null;
    if (err.sw === 0x6985) {
      touch(false);
      notice(word ?? err.message, 'err');
    } else {
      notice(word ?? err.message ?? `${err.code ?? 'error'}`, 'err');
    }
    throw err;
  } finally {
    if (gated) touch(false);
  }
}

function setDeviceDot(stateName) {
  state.deviceState = stateName;
  const dot = $('device-dot');
  dot.className = stateName;
  dot.textContent =
    stateName === 'connected' ? 'connected' :
    stateName === 'absent' ? 'not present' :
    stateName === 'busy' ? 'busy' : 'checking';
}

// --- device card (US-1702) ----------------------------------------------------

const pairing = createPairing({
  requestDevice: (opts) => navigator.hid.requestDevice(opts),
  call: api.call,
  persist: (h) => {
    try {
      chrome.storage.session.set({ nostrDeviceCard: h });
    } catch { /* no session storage — the fresh check decides on reopen */ }
  },
});

function renderDeviceCard(h) {
  if (!h) return;
  state.lastHealth = h;
  if (h.state === 'busy') {
    // The probe window is rate-limited, not broken — amber, and the boot
    // path retries once below.
    setDeviceDot('busy');
    $('device-state').textContent = 'busy — retrying in a second';
    return;
  }
  setDeviceDot(h.state === 'connected' ? 'connected' : 'absent');
  $('device-state').innerHTML =
    h.state === 'connected'
      ? 'fapico2 board <b>connected</b>'
      : h.state === 'absent'
        ? 'no fapico2 board granted — connect it'
        : 'device error';
}

async function healthCheck({ force = false } = {}) {
  let h = await pairing.health({ force });
  if (h.state === 'busy') {
    // The worker's 1 s probe window was busy: one retry after it lapses.
    await new Promise((r) => setTimeout(r, 1100));
    h = await pairing.health({ force: true });
  }
  renderDeviceCard(h);
}

// The chooser: only this button, only in this gesture. (US-1702: never from
// a page, never without a gesture — the stub assertion in the tests pins it.)
$('connect').addEventListener('click', async () => {
  if (!navigator.hid) {
    setDeviceDot('absent');
    notice('WebHID is not available in this browser', 'err');
    return;
  }
  try {
    const health = await pairing.connect();
    renderDeviceCard(health ?? pairing.lastHealth);
    await loadKeys();
  } catch (err) {
    if (err?.name === 'NotFoundError') {
      notice('no device selected', 'err');
    } else {
      notice(err.message ?? 'the chooser failed', 'err');
    }
  }
});

// --- keys home (US-1703) -------------------------------------------------------

async function loadKeys() {
  const list = $('keys-list');
  try {
    const keys = await api.call('list_keys');
    state.keys = keys;
    const model = renderKeysModel(keys);
    const cells = Array.from({ length: SLOTS }, (_, i) =>
      model.rows.some((r) => r.idx === i)
        ? `<span class="used">■</span>`
        : `<span>·</span>`,
    ).join('');
    $('occupancy').innerHTML = `${model.occupied}/${SLOTS} slots <span class="cells">${cells}</span>`;
    if (model.rows.length === 0) {
      list.innerHTML = `<div class="empty">no keys on the device —<br>generate or import one</div>`;
      return;
    }
    list.innerHTML = model.rows
      .map(
        (r) => `
      <div class="key-row">
        <span class="key-idx">${r.idx}</span>
        <span class="key-npub">
          <span class="bech">${r.npubBech32.slice(0, 20)}…${r.npubBech32.slice(-4)}</span><br>
          <span class="hex">${r.npub.slice(0, 16)}…</span>
          ${r.label ? `<br><span class="key-label">“${escapeHtml(r.label)}”</span>` : ''}
        </span>
        <span class="key-actions">
          <button data-act="label" data-idx="${r.idx}" title="Set label">label</button>
          <button data-act="export" data-idx="${r.idx}" title="Export key">export</button>
          <button data-act="delete" data-idx="${r.idx}" title="Delete key">delete</button>
        </span>
      </div>`,
      )
      .join('');
  } catch (err) {
    list.innerHTML = '';
    notice(err.message ?? 'could not list keys', 'err');
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

$('keys-list').addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-act]');
  if (!btn) return;
  const idx = Number(btn.dataset.idx);
  const row = state.keys.find((k) => k.idx === idx);
  if (!row) return;
  if (btn.dataset.act === 'delete') openDelete(row);
  if (btn.dataset.act === 'label') openLabel(row);
  if (btn.dataset.act === 'export') openExport(row);
});

// --- generate (US-1704) ----------------------------------------------------------

function openGenerate() {
  state.genSlot = null;
  const model = renderKeysModel(state.keys);
  $('gen-slots').innerHTML = Array.from({ length: SLOTS }, (_, i) => {
    const free = model.free.includes(i);
    return `<button class="${free ? 'free' : 'taken'}" data-slot="${i}" ${free ? '' : 'disabled'}>${i}</button>`;
  }).join('');
  $('gen-confirm').disabled = true;
  notice('');
  show('generate');
}

$('gen-slots').addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-slot]');
  if (!btn || btn.disabled) return;
  state.genSlot = Number(btn.dataset.slot);
  $('gen-slots').querySelectorAll('button').forEach((b) => b.classList.toggle('selected', b === btn));
  $('gen-confirm').disabled = false;
});

$('gen-confirm').addEventListener('click', async () => {
  if (state.genSlot == null) return;
  try {
    await deviceCall('generate_key', state.genSlot);
    notice(`key generated in slot ${state.genSlot}`, 'ok');
    await loadKeys();
    show('keys');
  } catch { /* the notice carries the named failure */ }
});
$('gen-cancel').addEventListener('click', () => show('keys'));
$('go-generate').addEventListener('click', openGenerate);

// --- import (US-1705) --------------------------------------------------------------

$('import-next').addEventListener('click', () => {
  try {
    state.import = decodeImportSecret($('import-secret').value);
    // The paste is validated: the input is dropped from the DOM immediately.
    $('import-secret').value = '';
    $('import-npub').textContent = npubBech32(state.import.npubHex);
    const model = renderKeysModel(state.keys);
    $('import-slots').innerHTML = Array.from({ length: SLOTS }, (_, i) => {
      const free = model.free.includes(i);
      return `<button class="${free ? 'free' : 'taken'}" data-slot="${i}" ${free ? '' : 'disabled'}>${i}</button>`;
    }).join('');
    state.importSlot = null;
    $('import-confirm').hidden = false;
    $('import-next').hidden = true;
    $('import-confirm-btn').hidden = false;
    $('import-confirm-btn').disabled = true;
    notice('');
  } catch (err) {
    notice(err.message, 'err'); // the scrub rule: the message names the problem, not the paste
  }
});

$('import-slots').addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-slot]');
  if (!btn || btn.disabled) return;
  state.importSlot = Number(btn.dataset.slot);
  $('import-slots').querySelectorAll('button').forEach((b) => b.classList.toggle('selected', b === btn));
  $('import-confirm-btn').disabled = false;
});

$('import-confirm-btn').addEventListener('click', async () => {
  if (!state.import || state.importSlot == null) return;
  try {
    // Confirm-then-send: the local validation and the user's confirmation
    // both precede the device call.
    await deviceCall('import_key', state.importSlot, state.import.scalarHex);
    state.import = null; // the scalar hex is dropped the moment it is used
    notice('key imported', 'ok');
    await loadKeys();
    show('keys');
  } catch { /* notice carries the named failure */ }
});
$('import-cancel').addEventListener('click', () => {
  state.import = null;
  $('import-secret').value = '';
  $('import-confirm').hidden = true;
  $('import-next').hidden = false;
  $('import-confirm-btn').hidden = true;
  show('keys');
});
$('go-import').addEventListener('click', () => {
  $('import-confirm').hidden = true;
  $('import-next').hidden = false;
  $('import-confirm-btn').hidden = true;
  show('import');
});

// --- delete (US-1706) ----------------------------------------------------------------

function openDelete(row) {
  state.deleteTarget = row;
  $('delete-what').innerHTML =
    `This destroys <code>${npubBech32(row.pubkey)}</code> (slot ${row.idx}${row.label ? `, “${escapeHtml(row.label)}”` : ''}). The key is gone from the device.`;
  $('delete-understand').checked = false;
  $('delete-confirm').disabled = true;
  show('delete');
}
$('delete-understand').addEventListener('change', (ev) => {
  $('delete-confirm').disabled = !ev.target.checked;
});
$('delete-confirm').addEventListener('click', async () => {
  const row = state.deleteTarget;
  if (!row) return;
  try {
    await deviceCall('delete_key', row.idx, row.pubkey);
    notice(`slot ${row.idx} deleted`, 'ok');
    await loadKeys();
    show('keys');
  } catch { /* a mismatched echo is a typed store-fault error — never a green checkmark */ }
});
$('delete-cancel').addEventListener('click', () => show('keys'));

// --- label (US-1706) -------------------------------------------------------------------

function openLabel(row) {
  state.labelTarget = row;
  $('label-what').innerHTML = `Label for <code>${npubBech32(row.pubkey).slice(0, 20)}…</code> (slot ${row.idx})`;
  $('label-input').value = row.label ?? '';
  updateLabelBytes();
  show('label');
}
function updateLabelBytes() {
  const bytes = new TextEncoder().encode($('label-input').value);
  $('label-bytes').textContent = `${bytes.length}/32 bytes`;
  $('label-bytes').style.color = bytes.length > 32 ? 'var(--err)' : 'var(--ink-dim)';
}
$('label-input').addEventListener('input', updateLabelBytes);
$('label-confirm').addEventListener('click', async () => {
  const row = state.labelTarget;
  if (!row) return;
  try {
    const bytes = validateLabel($('label-input').value); // byte length, not char count
    // Preview the exact bytes sent: shown in the notice as they cross.
    notice(`sending ${[...bytes].length} byte(s) — touch to confirm`);
    await deviceCall('set_label', row.idx, $('label-input').value);
    notice('label set', 'ok');
    await loadKeys();
    show('keys');
  } catch { /* notice carries the named failure */ }
});
$('label-cancel').addEventListener('click', () => show('keys'));

// --- export (US-1706/D5) ------------------------------------------------------------------

function openExport(row) {
  state.exportTarget = row;
  $('export-what').innerHTML = `Export the secret of <code>${npubBech32(row.pubkey).slice(0, 20)}…</code> (slot ${row.idx}).`;
  $('export-understand').checked = false;
  $('export-confirm').disabled = true;
  $('export-out').hidden = true;
  show('export');
}
$('export-understand').addEventListener('change', (ev) => {
  $('export-confirm').disabled = !ev.target.checked;
});
$('export-confirm').addEventListener('click', async () => {
  const row = state.exportTarget;
  if (!row) return;
  try {
    const { scalar } = await deviceCall('export_key', row.idx);
    // The explicit reveal: once, in this window, dropped on close — the
    // scalar is rendered as nsec bech32 so a user can paste it into a
    // software client, and nowhere else.
    $('export-out').hidden = false;
    $('export-scalar').textContent = bech32.encode(
      'nsec',
      bech32.toWords((() => {
        const out = new Uint8Array(32);
        for (let i = 0; i < 32; i++) out[i] = parseInt(scalar.slice(i * 2, i * 2 + 2), 16);
        return out;
      })()),
    );
    notice('');
  } catch { /* notice carries the named failure */ }
});
$('export-cancel').addEventListener('click', () => {
  $('export-scalar').textContent = '';
  show('keys');
});

// --- sites (US-1701) -----------------------------------------------------------------------

async function loadSites() {
  const list = $('sites-list');
  try {
    const grants = await api.call('get_grants');
    if (grants.length === 0) {
      list.innerHTML = `<div class="empty">no site has a grant</div>`;
      return;
    }
    list.innerHTML = grants
      .map(
        (g) => `
      <div class="key-row">
        <span class="key-npub">
          <span class="bech">${escapeHtml(g.host)}</span><br>
          <span class="hex">${g.methods.join(', ')} — ${new Date(g.grantedAt).toISOString().slice(0, 10)}</span>
        </span>
        <span class="key-actions"><button data-revoke="${escapeHtml(g.host)}">revoke</button></span>
      </div>`,
      )
      .join('');
  } catch (err) {
    notice(err.message ?? 'could not list grants', 'err');
  }
}
$('sites-list').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-revoke]');
  if (!btn) return;
  await api.call('revoke_grant', btn.dataset.revoke);
  await loadSites();
});
$('revoke-all').addEventListener('click', async () => {
  await api.call('revoke_all');
  await loadSites();
});

// --- nav & boot ----------------------------------------------------------------------------

$('nav-keys').addEventListener('click', () => { show('keys'); });
$('nav-sites').addEventListener('click', () => { show('sites'); loadSites(); });

(async function boot() {
  show('keys');
  // Reopen to truth: the persisted device card answers before the first
  // fresh probe.
  try {
    const got = await chrome.storage.session.get('nostrDeviceCard');
    const last = got?.nostrDeviceCard;
    if (last?.state === 'connected') {
      setDeviceDot('connected');
      $('device-state').innerHTML = 'fapico2 board <b>connected</b>';
    } else if (last) {
      setDeviceDot('absent');
      $('device-state').textContent = 'no fapico2 board granted — connect it';
    }
  } catch { /* no session storage — the fresh check decides */ }
  await healthCheck({ force: true });
  await loadKeys();
})();
