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
