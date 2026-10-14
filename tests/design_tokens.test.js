// US-1711 — the token layer. popup.css and prompt.css used to carry
// duplicate :root blocks (and drift: --amber-dim, --ok, --r existed only
// in popup.css). The tokens now live in src/popup/tokens.css — the :root
// union plus the shared primitives — and every page links it before its
// own stylesheet, which keeps only page-scoped layout (D-UX3). These
// tests pin the extraction so it can never quietly regress.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFile(join(root, p), 'utf8');

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

// The union of the old popup.css and prompt.css :root sets: prompt had a
// subset, popup carried --amber-dim, --ok and --r alone.
const TOKEN_VARS = [
  '--bg', '--bg-raise', '--bg-inset', '--line', '--line-strong',
  '--ink', '--ink-dim', '--amber', '--amber-dim', '--ok', '--err',
  '--mono', '--sans', '--r',
];

test('US-1711 tokens.css declares the :root union of both variable sets', async () => {
  const css = stripComments(await read('src/popup/tokens.css'));
  const rootBlock = css.match(/:root\s*\{([\s\S]*?)\}/);
  assert.ok(rootBlock, 'tokens.css carries a :root block');
  for (const v of TOKEN_VARS) {
    assert.match(
      rootBlock[1],
      new RegExp(`${v}\\s*:`),
      `${v} is declared in tokens.css :root`,
    );
  }
});

test('US-1711 the page stylesheets declare no -- custom properties', async () => {
  for (const file of ['src/popup/popup.css', 'src/prompt/prompt.css']) {
    const css = stripComments(await read(file));
    const declared = css.match(/--[A-Za-z][\w-]*\s*:/g) ?? [];
    assert.deepEqual(declared, [], `${file} declares no -- custom properties (var() usage is fine)`);
  }
});

test('US-1711 every page links tokens.css before its page stylesheet', async () => {
  for (const [page, sheet] of [
    ['src/popup/popup.html', 'popup.css'],
    ['src/popup/connect.html', 'popup.css'],
    ['src/prompt/prompt.html', 'prompt.css'],
  ]) {
    const html = await read(page);
    const hrefs = [...html.matchAll(/<link\b[^>]*>/g)]
      .map((m) => (m[0].match(/href="([^"]+)"/) ?? [])[1])
      .filter(Boolean);
    assert.ok(hrefs.includes('tokens.css'), `${page} links tokens.css`);
    assert.ok(
      hrefs.indexOf('tokens.css') < hrefs.indexOf(sheet),
      `${page} links tokens.css before ${sheet}`,
    );
  }
});

// US-1733 — the a11y pass. Contrast is checked from the actual hex pairs in
// tokens.css (one source of truth); the type-size floor and focus are asserted
// against the page sheets. The size floor is the red→green case: method-chip
// and footnote were 10px, below the 11px floor.

// --- WCAG contrast -----------------------------------------------------------

function relativeLuminance(hex) {
  const clean = hex.length === 4 ? hex.split('').map((c) => c + c).join('') : hex;
  const r = parseInt(clean.slice(1, 3), 16);
  const g = parseInt(clean.slice(3, 5), 16);
  const b = parseInt(clean.slice(5, 7), 16);
  const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * lin(r) + 0.715 * lin(g) + 0.0722 * lin(b);
}

function contrastRatio(fore, back) {
  const L1 = relativeLuminance(fore);
  const L2 = relativeLuminance(back);
  const lighter = Math.max(L1, L2);
  const darker = Math.min(L1, L2);
  return (lighter + 0.05) / (darker + 0.05);
}

// --- US-1733 contrast: body text meets 4.5:1 against its background ----------

test('US-1733 body text (ink on bg) meets 4.5:1', async () => {
  const css = stripComments(await read('src/popup/tokens.css'));
  const hex = (name) => css.match(new RegExp(`${name}\\s*:\\s*(#[0-9a-fA-F]{6})`))[1];
  const ink = hex('--ink');
  const bg = hex('--bg');
  const ratio = contrastRatio(ink, bg);
  assert.ok(ratio >= 4.5, `ink on bg is ${ratio.toFixed(2)}:1, needs >= 4.5:1`);
});

test('US-1733 secondary text (ink-dim) meets 4.5:1 on every background it sits on', async () => {
  const css = stripComments(await read('src/popup/tokens.css'));
  const hex = (name) => css.match(new RegExp(`${name}\\s*:\\s*(#[0-9a-fA-F]{6})`))[1];
  const inkDim = hex('--ink-dim');
  const pairs = [
    ['ink-dim on bg', inkDim, hex('--bg')],
    ['ink-dim on bg-inset', inkDim, hex('--bg-inset')],
    ['ink-dim on bg-raise', inkDim, hex('--bg-raise')],
  ];
  for (const [label, fore, back] of pairs) {
    const ratio = contrastRatio(fore, back);
    assert.ok(ratio >= 4.5, `${label} is ${ratio.toFixed(2)}:1, needs >= 4.5:1`);
  }
});

// --- US-1733 type-size floor: no interactive label below 11px ----------------

function cssRules(css) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css)) !== null) out.push({ selector: m[1].trim(), decl: m[2] });
  return out;
}

function fontSizePx(decl) {
  const explicit = decl.match(/font-size:\s*(\d+(?:\.\d+)?)px/i);
  if (explicit) return parseFloat(explicit[1]);
  const shorthand = decl.match(/font:\s*[^;]*?\b(\d+(?:\.\d+)?)px/i);
  return shorthand ? parseFloat(shorthand[1]) : null;
}

function isInteractive(selector) {
  if (/^@/.test(selector)) return false;
  return /\b(button|nav|label)\b/.test(selector)
    || /\.slot-picker\s+button/.test(selector)
    || /\.method-chip\b/.test(selector)
    || /\.footnote\b/.test(selector);
}

test('US-1733 no interactive label renders below 11px', async () => {
  for (const file of ['src/popup/popup.css', 'src/prompt/prompt.css']) {
    const css = stripComments(await read(file));
    for (const { selector, decl } of cssRules(css)) {
      if (!isInteractive(selector)) continue;
      const size = fontSizePx(decl);
      if (size == null) continue; // inherits the page base — not this rule's concern
      assert.ok(size >= 11, `${file}: ${selector} is ${size}px, needs >= 11px`);
    }
  }
});

// --- US-1733 focus: a visible focus path on interactive elements -------------

test('US-1733 buttons and inputs carry a shared focus-visible ring', async () => {
  const css = stripComments(await read('src/popup/tokens.css'));
  assert.match(css, /button:focus-visible/, 'buttons show a focus ring');
  assert.match(css, /input:focus-visible/, 'inputs show a focus ring');
  assert.match(css, /:focus-visible\s*\{[^}]*outline/, 'the focus ring is an outline');
});

// --- US-1733 the touch bar's role="status" survives the redesign -------------

test('US-1733 the touch bar is an aria status region on every page', async () => {
  for (const page of ['src/popup/popup.html', 'src/popup/connect.html', 'src/prompt/prompt.html']) {
    const html = await read(page);
    const m = html.match(/<div[^>]*id="touch-bar"[^>]*>/);
    assert.ok(m, `${page} has a #touch-bar element`);
    assert.match(m[0], /role="status"/, `${page} touch-bar is a status region`);
  }
});
