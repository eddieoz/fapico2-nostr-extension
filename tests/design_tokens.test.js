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
