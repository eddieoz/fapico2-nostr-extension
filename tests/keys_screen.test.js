// US-1726 — the key ROWS on the Keys screen. Each key is now a card: the
// label (or "slot N" when unlabeled) is the title, the npub is ONE clipped
// line, and a copy button sits in the actions row OUTSIDE the <label> that
// carries the active-key radio — so copying never silently switches the active
// key (the skeptic's destructive-adjacent finding). No jsdom in this repo, so
// the assertions parse popup.js and popup.css as text — the structural facts a
// render would prove here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SLOTS, deleteConfirmModel } from '../src/popup/keys.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFile(join(root, p), 'utf8');

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');

/** The first top-level `selector { ... }` block whose selector matches `re`. */
function block(css, re) {
  const m = css.match(new RegExp(`${re.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([\\s\\S]*?)\\}`));
  return m ? m[1] : null;
}

const css = stripComments(await read('src/popup/popup.css'));
const src = await read('src/popup/popup.js');
const html = await read('src/popup/popup.html');

/** The whitespace-separated `class` attribute of the button with this id, or null. */
function classes(id) {
  const m = html.match(new RegExp(`<button[^>]*id="${id}"([^>]*)>`));
  return m ? ((m[1].match(/class="([^"]*)"/) ?? [])[1] ?? '') : null;
}
function hasClass(id, cls) {
  const c = classes(id);
  return c != null && c.split(/\s+/).includes(cls);
}

/** The body of the single key-row template (between <div class="key-row"> and its close). */
function rowBody() {
  const m = src.match(/<div class="key-row">([\s\S]*?)\n {6}<\/div>/);
  return m ? m[1] : null;
}

test('US-1726 the row renders a copy button in the actions (data-act="copy")', () => {
  assert.match(src, /data-act="copy"/, 'a copy action exists');
});

test('US-1726 the copy button is OUTSIDE the active-key <label>, not inside it', () => {
  const body = rowBody();
  assert.ok(body, 'a key-row template renders');
  const labelClose = body.indexOf('</label>');
  const copyBtn = body.indexOf('data-act="copy"');
  assert.ok(labelClose >= 0, 'the row still carries the active-key <label>');
  assert.ok(copyBtn >= 0, 'the row carries a copy button');
  assert.ok(copyBtn > labelClose, 'the copy button comes AFTER the label closes — it is a sibling, never a descendant');
});

test('US-1726 the copy button is a real <button>, not text inside the label', () => {
  const body = rowBody();
  assert.match(body, /<button[^>]*data-act="copy"/, 'the copy control is a <button>');
});

test('US-1726 the npub is ONE clipped line — no <br> wrapping the bech32', () => {
  const body = rowBody();
  assert.ok(!/<br>/.test(body), 'no line break inside the row — the npub is a single line');
});

test('US-1726 the clipped npub keeps the full value as its title and shows an ellipsis', () => {
  const clipped = src.match(/const clipped =[\s\S]*?slice\(0,\s*20\)[^;]*…/);
  assert.ok(clipped, 'the clipped npub is slice(0,20)…last4 — one line, full value recoverable');
  // the bech span carries the full npub as its title so it stays copyable
  assert.match(rowBody(), /<span class="bech" title="\$\{full\}"/, 'the bech span exposes the full npub as title');
});

test('US-1726 the title is the label, or "slot N" when unlabeled', () => {
  assert.match(src, /const title = r\.label \|\| `slot \$\{r\.idx\}`/, 'title falls back to slot N');
  assert.ok(rowBody().includes('<span class="key-title">${escapeHtml(title)}</span>'), 'the title renders the label/slot');
});

test('US-1726 action buttons are ≥12px type (was 10px)', () => {
  const actionsBtn = block(css, '.key-actions button');
  assert.ok(actionsBtn, '.key-actions button rule exists');
  const size = actionsBtn && actionsBtn.match(/font-size:\s*(\d+)/);
  assert.ok(size, 'the rule declares a font-size');
  assert.ok(Number(size[1]) >= 12, `action buttons are at least 12px (found ${size && size[1]}px)`);
});

test('US-1726 the click gesture copies only the FULL npub via navigator.clipboard.writeText', () => {
  const copyFn = src.match(/function copyNpub[\s\S]*?\n\}/);
  assert.ok(copyFn, 'a copyNpub handler exists');
  const body = copyFn[0];
  assert.match(body, /navigator\.clipboard\.writeText\(/, 'it writes to the clipboard from the gesture');
  assert.match(body, /npubBech32\(row\.pubkey\)/, 'the value written is the full bech32 npub');
  assert.ok(!/set_active_slot|active-slot|activeKey/.test(body), 'copying never touches the active key');
});

test('US-1726 clicking copy does NOT switch the active key (radio change is untouched)', () => {
  const click = src.match(/'keys-list'\)\.addEventListener\('click'[\s\S]*?\n\}\);/);
  assert.ok(click, 'the keys-list click handler exists');
  const body = click[0];
  assert.match(body, /dataset\.act === 'copy'\)\s*return copyNpub\(row\)/, 'the copy branch is an early return');
  assert.ok(!/set_active_slot|set_active_slot/.test(body), 'the click handler never sets the active slot');
});

test('US-1726 the radio and its snap-back change handler are still the active-key path', () => {
  const change = src.match(/'keys-list'\)\.addEventListener\('change'[\s\S]*?\n\}\);/);
  assert.ok(change, 'the change handler still exists');
  assert.match(change[0], /set_active_slot/, 'changing the radio still sets the active slot');
  assert.match(change[0], /renderActive\(\)/, 'on error it snaps back via renderActive');
  assert.match(src, /input\[name="active-key"\]/, 'the active-key radio is still rendered');
});

test('US-1726 the occupancy cells stay (nothing removed from the home)', () => {
  assert.match(src, /'occupancy'/, 'occupancy is still rendered');
  assert.match(rowBody(), /class="key-actions"/, 'the actions row is still part of the card');
});

// --- US-1727: amber semantics + a distinct disabled state --------------------

test('US-1727 every touch-leading primary carries the amber class', () => {
  for (const id of ['gen-confirm', 'import-confirm-btn', 'label-confirm', 'pin-change-confirm-btn']) {
    assert.ok(hasClass(id, 'amber'), `${id} is a touch-leading primary and carries .amber`);
  }
});

test('US-1727 Delete & touch and Revoke all keep their danger styling', () => {
  for (const id of ['delete-confirm', 'revoke-all']) {
    assert.ok(hasClass(id, 'danger'), `${id} keeps .danger`);
    assert.ok(!hasClass(id, 'amber'), `${id} is not amber`);
  }
});

test('US-1727 non-touch primaries are neutral-filled (no amber)', () => {
  for (const id of ['connect', 'import-next']) {
    assert.ok(hasClass(id, 'primary'), `${id} is a primary`);
    assert.ok(!hasClass(id, 'amber'), `${id} is a non-touch primary — neutral, not amber`);
  }
});

test('US-1727 the disabled primitive lives in the token layer', async () => {
  const tokens = stripComments(await read('src/popup/tokens.css'));
  const root = tokens.match(/:root\s*\{([\s\S]*?)\}/);
  assert.ok(root, 'tokens.css carries a :root block');
  for (const v of ['--disabled-bg', '--disabled-border', '--disabled-color']) {
    assert.match(root[1], new RegExp(`${v}\\s*:`), `${v} is declared in tokens.css :root`);
  }
});

test('US-1727 disabled renders inert: inset bg, muted border+text, no amber, full opacity', async () => {
  const disabled = block(css, 'button:disabled');
  assert.ok(disabled, 'a button:disabled rule exists');
  assert.match(disabled, /background:\s*var\(--disabled-bg\)/, 'inset (disabled) background');
  assert.match(disabled, /border-color:\s*var\(--disabled-border\)/, 'muted (disabled) border');
  assert.match(disabled, /color:\s*var\(--disabled-color\)/, 'muted (disabled) text');
  assert.ok(!/opacity:\s*0/.test(disabled), 'no opacity-only hint — a disabled primary is not faded');
  assert.ok(!/var\(--amber\)/.test(disabled), 'no amber when disabled');
});

test('US-1727 the primary rule is neutral-filled and the amber rule is separate', async () => {
  const primary = block(css, 'button.primary');
  const amber = block(css, 'button.amber');
  assert.ok(primary, 'a button.primary rule exists');
  assert.ok(amber, 'a button.amber rule exists');
  assert.ok(/var\(--disabled-bg\)|var\(--bg-inset\)/.test(primary), 'the neutral primary fills with the inset background');
  assert.ok(!/var\(--amber\)/.test(primary), 'the neutral primary is NOT amber');
  assert.match(amber, /var\(--amber\)/, 'the amber primary fills with --amber');
});

// --- US-1728: the slot grid — eight slots, one row, honest taken-state -------

test('US-1728 there are eight slots', () => {
  assert.equal(SLOTS, 8, 'the picker has eight slots');
});

test('US-1728 each slot renders one button carrying its slot as data-slot (DOM order = slot order)', () => {
  assert.match(src, /Array\.from\(\{ length: SLOTS \}/, 'one button per slot');
  assert.match(src, /data-slot="\$\{i\}"/, 'the button carries index i as data-slot — focus order reads slot order');
  assert.match(src, /free \? 'free' : 'taken'/, 'a slot carries free or taken');
});

test('US-1728 the picker never shuffles focus order with tabindex', () => {
  assert.ok(!/tabindex/.test(src), 'no tabindex on the pickers — Tab follows slot order');
});

test('US-1728 the eight slots stay on one row (never wrap)', () => {
  const picker = block(css, '.slot-picker');
  assert.ok(picker, 'a .slot-picker rule exists');
  assert.match(picker, /flex-wrap:\s*nowrap/, 'slots are nowrap — all eight fit on one row');
  const btn = block(css, '.slot-picker button');
  assert.ok(btn, 'a .slot-picker button rule exists');
  assert.match(btn, /flex:\s*1\s*1\s*0/, 'the slots share the width evenly (never drop to a second line)');
});

test('US-1728 a taken slot is unmistakable: filled + muted + inert, not only a line-through', () => {
  const taken = block(css, '.slot-picker button.taken');
  assert.ok(taken, 'a .slot-picker button.taken rule exists');
  assert.match(taken, /background:\s*var\(--bg-inset\)/, 'taken is filled (a muted, dead fill)');
  assert.match(taken, /color:\s*var\(--ink-dim\)/, 'taken is muted');
  assert.match(taken, /cursor:\s*not-allowed/, 'taken is inert');
  assert.match(taken, /text-decoration:\s*line-through/, 'taken keeps the line-through');
});

test('US-1728 a free slot reads open/clickable, distinct from taken', () => {
  const free = block(css, '.slot-picker button.free');
  assert.ok(free, 'a .slot-picker button.free rule exists');
  assert.match(free, /background:\s*var\(--bg\)/, 'free is a lighter open fill');
  assert.match(free, /cursor:\s*pointer/, 'free is clickable');
});

// --- US-1729: delete confirm — recognition, not a bech32 wall ---------------

const DEL_PUBKEY = 'a'.repeat(64); // any 32-byte hex; bech32 length is what matters
const delRow = (idx, label) => ({ pubkey: DEL_PUBKEY, idx, label });

test('US-1729 a labeled target names the label, a truncated npub, and the slot', () => {
  const m = deleteConfirmModel(delRow(3, 'my wallet'), 0);
  assert.equal(m.name, '“my wallet”', 'the label is the primary name');
  assert.match(m.npub, /…/, 'the npub is truncated — not the full 63-char wall');
  assert.ok(m.npub.length < 40, `the truncated npub is short (${m.npub.length} chars)`);
  assert.equal(m.slot, 3, 'the slot number is shown');
  assert.equal(m.whereClause, ' (slot 3)', 'a labeled key still carries its slot');
});

test('US-1729 an unlabeled target uses the slot number as the primary name', () => {
  const m = deleteConfirmModel(delRow(5, null), 0);
  assert.equal(m.name, 'slot 5', 'the slot number is the primary name when unlabeled');
  assert.ok(m.npub.length > 0, 'the truncated npub never disappears entirely');
  assert.equal(m.whereClause, '', 'no redundant "(slot N)" when the slot already IS the name');
});

test('US-1729 the active-key sentence appears iff the target is active', () => {
  const expected = 'This is your active key — after deleting, the active key resets to slot 0.';
  assert.equal(deleteConfirmModel(delRow(1, 'x'), 1).activeSentence, expected);
  assert.equal(deleteConfirmModel(delRow(1, 'x'), 9).activeSentence, null, 'absent when the target is not active');
});

test('US-1729 the popup renders the delete confirm from the model (naming stays single-sourced)', () => {
  assert.match(src, /const m = deleteConfirmModel\(row, state\.activeSlot\)/, 'openDelete builds from deleteConfirmModel');
  assert.match(src, /escapeHtml\(m\.name\)/, 'the name is rendered (escaped)');
  assert.match(src, /m\.activeSentence/, 'the active sentence is appended only when present');
});


// US-1739 — the connect-first screen's Generate/Import open the same flows
// as the keys home. They render disabled while the board is absent
// (US-1716), so the wiring is unreachable today — but the affordance is
// never a dead one if a future state enables them.
test('US-1739 the first-run Generate/Import buttons open their screens', async () => {
  const src = await read('src/popup/popup.js');
  assert.match(src, /\$\('go-generate-first'\)\.addEventListener\('click', \(\) => openGenerate\(\)\)/,
    'Generate opens the generate flow');
  assert.match(src, /\$\('go-import-first'\)\.addEventListener\('click', openImport\)/,
    'Import opens the import flow (shared with the keys home)');
});

// US-1740 — the key row is a two-line card: the pick line (radio + title +
// clipped npub) owns the full width, the actions line spreads beneath it. At
// 360px the four buttons beside the bech32 squeezed the npub clip to a few
// characters — the single-line layout is pinned gone.
test('US-1740 the key row stacks: the pick owns the width, the actions spread under it', async () => {
  const css = stripComments(await read('src/popup/popup.css'));
  const row = block(css, '.key-row');
  assert.ok(row, 'the key-row rule exists');
  assert.match(row, /flex-wrap:\s*wrap/, 'the row may wrap to two lines');
  const pick = css.match(/\.key-pick\s*\{([^}]*)\}/);
  assert.ok(pick, 'the key-pick rule exists');
  assert.match(pick[1], /flex:\s*1 1 100%/, 'the pick line owns the full width');
  const actions = css.match(/\.key-actions\s*\{([^}]*)\}/);
  assert.ok(actions, 'the key-actions rule exists');
  assert.match(actions[1], /width:\s*100%/, 'the actions line spans the card');
});

// US-1746 — the card's action is ALWAYS Connect: a Disconnect that calls
// HIDDevice.forget() bricks re-pairing (the vendor interface is hidden by
// the picker — a revoked grant can never be re-granted). The toggle is
// pinned GONE.
test('US-1746 the card button never toggles to Disconnect and never calls unpair_device', async () => {
  const src = await read('src/popup/popup.js');
  assert.doesNotMatch(src, /'Disconnect'/, 'no Disconnect label anywhere');
  assert.doesNotMatch(src, /unpair_device/, 'the popup never calls unpair_device');
});