// The popup: pairing (US-1702), key management (US-1703..1706) and the
// Sites revocation screen (US-1701). An extension page — a trusted sender —
// so nothing here prompts for site consent; the device touch is the consent
// for every mutating op and the touch bar (the amber bar) surfaces it.
//
// The Connect button is the product's only chooser entry point: it hands
// off to the connect.html tab, where navigator.hid.requestDevice runs under
// a click gesture in a real tab (a chooser anchored to the action popup or
// to a popup-type window is cancelled instantly). The worker itself never
// opens a chooser.

import { createPortClient } from '../shared/port-client.js';
import { bech32 } from '@scure/base';
import { createPairing } from './pairing.js';
import {
  renderKeysModel,
  activeKeyModel,
  decodeImportSecret,
  validateLabel,
  npubBech32,
  SW_WORDS,
  SLOTS,
} from './keys.js';
import { homeScreenFor, homeActions, deviceCardModel, tryAgain } from './home-state.js';

const api = createPortClient();
const $ = (id) => document.getElementById(id);

const state = {
  keys: [],
  deviceState: 'checking',
  lastHealthAt: 0,
  activeSlot: 0, // US-1710 — the stored global active slot (0 = default)
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
  // One rendering per state: error keeps its own word so it never reads as the
  // absent "not present" (which would send a granted user back to "connect it").
  dot.textContent =
    stateName === 'connected' ? 'connected' :
    stateName === 'absent' ? 'not present' :
    stateName === 'busy' ? 'busy' :
    stateName === 'error' ? 'error' : 'checking';
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
  // US-1717 — one rendering path driven by the pure model, so the three
  // non-busy states can never drift back into a single rendering. busy is the
  // probe window (amber, retried once by the boot path); error is its own card
  // with a Try again action, never the absent "connect it" line.
  const model = deviceCardModel(h);
  setDeviceDot(model.dot);
  const stateEl = $('device-state');
  stateEl.innerHTML = model.line;
  const tryAgainBtn = $('try-again');
  if (tryAgainBtn) tryAgainBtn.hidden = !model.tryAgain;
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

// US-1715 — the ONE home-screen decision, driven by the resolved device health.
// The swap only touches the .screen elements below the always-present device
// card, so no layout flash occurs above it. absent → connect-first, error →
// device-error, busy/connected → the normal keys home.
function renderHomeState() {
  show(homeScreenFor(state.lastHealth));
  // US-1716 — when the board is absent, Generate and Import are disabled with a
  // single stated reason; connected, they work. The connect-first screen owns
  // these buttons, so this is the whole home-action state.
  const actions = homeActions(state.deviceState === 'connected');
  for (const id of ['go-generate-first', 'go-import-first']) {
    const btn = $(id);
    if (!btn) continue;
    btn.disabled = actions.generate === 'disabled';
    const word = id.includes('generate') ? 'Generate' : 'Import';
    btn.title = actions.reason ? `${word} a key — ${actions.reason}` : '';
    btn.setAttribute('aria-label', btn.title || word);
  }
}

// The chooser: only from an extension page, only under a click gesture.
// (US-1702: never from a web page, never without a gesture — the stub
// assertion in the tests pins it.) Chromium cancels a chooser anchored to
// the action popup — the dialog steals focus, the popup closes on blur and
// the request dies with it — so the actual chooser runs in a dedicated
// extension window (connect.html). This button hands off to it.
$('connect').addEventListener('click', async () => {
  if (!navigator.hid) {
    setDeviceDot('absent');
    notice('WebHID is not available in this browser', 'err');
    return;
  }
  try {
    // A tab, not a popup window: Chromium's chooser bubble closes itself
    // (kLostFocus) when anchored to a popup-type window — only a real tab
    // holds focus for it. Verified on Brave 151 and Chrome 154.
    await chrome.tabs.create({ url: chrome.runtime.getURL('connect.html') });
    window.close(); // the action popup has nothing left to show
  } catch {
    // No windows API in this context (tests, embedded runs): run the chooser
    // here rather than dead-ending.
    try {
      const health = await pairing.connect();
      renderDeviceCard(health ?? pairing.lastHealth);
      await loadKeys();
      // US-1716 — a mid-session connect re-renders the home to the normal state.
      renderHomeState();
    } catch (err) {
      if (err?.name === 'NotFoundError') {
        notice('no device selected', 'err');
      } else {
        notice(err.message ?? 'the chooser failed', 'err');
      }
    }
  }
});

// US-1717 — Try again: re-run the health check with force:true so a granted but
// failing board is re-probed instead of telling the user to "connect it".
// healthCheck re-renders the card on its way back, so one click issues exactly
// one forced probe.
$('try-again').addEventListener('click', () => tryAgain(() => healthCheck({ force: true })));

// --- keys home (US-1703) -------------------------------------------------------

/** US-1710 — the ONE render path for the strip and the radios: both feed
 *  from activeKeyModel (device truth + stored slot), so they cannot
 *  disagree. */
function renderActive() {
  const m = activeKeyModel(state.keys, state.activeSlot);
  const strip = $('active-strip');
  strip.textContent = m.strip;
  strip.classList.toggle('none', !m.active);
  for (const input of document.querySelectorAll('input[name="active-key"]')) {
    input.checked = m.active != null && Number(input.dataset.slot) === m.active.idx;
  }
}

async function loadActive() {
  try {
    state.activeSlot = (await api.call('get_active_slot')).slot;
  } catch {
    state.activeSlot = 0; // the fresh read failed: fall back to the default
  }
  renderActive();
}

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
      renderActive();
      return;
    }
    list.innerHTML = model.rows.map((r) => {
      // US-1726 — the label (or "slot N") is the title; the npub is ONE clipped
      // line (the full value rides along as the <span> title so it stays
      // recoverable). The copy button lives in the actions row, OUTSIDE the
      // <label>: a click-to-copy there can never also flip the active-key radio.
      const full = r.npubBech32;
      const clipped = full.length > 26 ? `${full.slice(0, 20)}…${full.slice(-4)}` : full;
      const title = r.label || `slot ${r.idx}`;
      return `
      <div class="key-row">
        <label class="key-pick" for="active-${r.idx}" title="Make this the active key">
          <input type="radio" name="active-key" id="active-${r.idx}" data-slot="${r.idx}" aria-label="Make slot ${r.idx} the active key">
          <span class="key-title">${escapeHtml(title)}</span>
          <span class="key-npub">
            <span class="bech" title="${full}">${clipped}</span>
          </span>
        </label>
        <span class="key-actions">
          <button type="button" data-act="copy" data-idx="${r.idx}" title="Copy npub to clipboard">copy</button>
          <button data-act="label" data-idx="${r.idx}" title="Set label">label</button>
          <button data-act="export" data-idx="${r.idx}" title="Export key">export</button>
          <button data-act="delete" data-idx="${r.idx}" title="Delete key">delete</button>
        </span>
      </div>`;
    }).join('');
    renderActive();
  } catch (err) {
    list.innerHTML = '';
    renderActive();
    notice(err.message ?? 'could not list keys', 'err');
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** US-1726 — copy the FULL npub (public material only) to the clipboard from
 *  the click gesture. This never touches the device and never switches the
 *  active key: the copy button is a sibling of the row's <label>, so clicking
 *  it cannot toggle the radio. */
async function copyNpub(row) {
  const npub = npubBech32(row.pubkey);
  try {
    await navigator.clipboard.writeText(npub);
    notice(`copied npub for slot ${row.idx}`, 'ok');
  } catch {
    notice('clipboard unavailable — copy it by hand', 'err');
  }
}

$('keys-list').addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-act]');
  if (!btn) return;
  const idx = Number(btn.dataset.idx);
  const row = state.keys.find((k) => k.idx === idx);
  if (!row) return;
  if (btn.dataset.act === 'copy') return copyNpub(row);
  if (btn.dataset.act === 'delete') openDelete(row);
  if (btn.dataset.act === 'label') openLabel(row);
  if (btn.dataset.act === 'export') openExport(row);
});

// US-1710 — the radio: instant (no device touch), confirmed before the UI
// moves — on error the radio snaps back and the typed notice shows.
$('keys-list').addEventListener('change', async (ev) => {
  const input = ev.target.closest('input[name="active-key"]');
  if (!input) return;
  const idx = Number(input.dataset.slot);
  try {
    await api.call('set_active_slot', idx);
    state.activeSlot = idx;
    renderActive();
    notice(
      `active key is now slot ${idx} — sites that cached your other npub will need to reconnect`,
      'ok',
    );
  } catch (err) {
    renderActive(); // snap back to the stored truth
    notice(err.message ?? 'could not set the active key', 'err');
  }
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
    await loadKeys();
    const activeSet = state.keys.some((k) => k.idx === state.activeSlot);
    notice(
      `key generated in slot ${state.genSlot}` +
        (activeSet ? '' : ' — no active key is set yet; pick it on the Keys screen to sign with it'),
      'ok',
    );
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
    await loadKeys();
    const activeSet = state.keys.some((k) => k.idx === state.activeSlot);
    notice(
      'key imported' +
        (activeSet ? '' : ' — no active key is set yet; pick it on the Keys screen to sign with it'),
      'ok',
    );
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
  if (row.idx === state.activeSlot) {
    $('delete-what').innerHTML += ` This is your active key — after deleting, the active key resets to slot 0.`;
  }
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
    const wasActive = row.idx === state.activeSlot;
    await deviceCall('delete_key', row.idx, row.pubkey);
    if (wasActive) state.activeSlot = 0; // the worker reset it; stay in lockstep
    notice(`slot ${row.idx} deleted` + (wasActive ? ' — the active key reset to slot 0' : ''), 'ok');
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
  // US-1715 — now that lastHealth has resolved, pick the home below the device
  // card (absent → connect-first, error → device-error, busy/connected → keys).
  renderHomeState();
  await loadKeys();
  await loadActive();
})();
