// US-1712 — the connect tab is a full-page centered card, not the popup's
// 360px strip pinned top-left. The flow logic in connect.js is untouched; only
// the page's layout changes. No jsdom in this repo, so the assertions parse the
// stylesheet and the page as text (the DOM-hook and link-order facts are all
// that a render would prove here).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFile(join(root, p), 'utf8');

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** The first top-level `selector { ... }` block whose selector matches `re`. */
function block(css, re) {
  const m = css.match(new RegExp(`${re.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([\\s\\S]*?)\\}`));
  return m ? m[1] : null;
}

test('US-1712 connect.css gives the body a full-viewport width — never 360px', async () => {
  const css = stripComments(await read('src/popup/connect.css'));
  const body = block(css, 'body');
  assert.ok(body, 'connect.css declares a body rule');
  assert.ok(!/width:\s*360px/.test(body), 'the body is not pinned to 360px');
  assert.ok(/width:\s*100vw|width:\s*100%/.test(body), 'the body fills the viewport');
});

test('US-1712 connect.html carries no inline 360px body rule either', async () => {
  const html = await read('src/popup/connect.html');
  const style = (html.match(/<style([\s\S]*?)<\/style>/) ?? [])[1] ?? '';
  assert.equal(style, '', 'the inline <style> (old 360px body) is gone');
});

test('US-1711/US-1712 connect.html links tokens.css, popup.css, connect.css in order', async () => {
  const html = await read('src/popup/connect.html');
  const hrefs = [...html.matchAll(/<link\b[^>]*href="([^"]+)"/g)].map((m) => m[1]);
  const order = { tokens: hrefs.indexOf('tokens.css'), popup: hrefs.indexOf('popup.css'), connect: hrefs.indexOf('connect.css') };
  assert.ok(order.tokens >= 0, 'links tokens.css');
  assert.ok(order.popup >= 0, 'links popup.css (shared primitives)');
  assert.ok(order.connect >= 0, 'links connect.css');
  assert.ok(order.tokens < order.popup && order.popup < order.connect,
    'tokens → popup → connect (connect.css last so it overrides the 360px body)');
});

test('US-1712 the card sits inside a full-viewport body with the flow DOM hooks intact', async () => {
  const html = await read('src/popup/connect.html');
  // the centered card is present, inside <body>…</body>
  const body = html.match(/<body([\s\S]*?)<\/body>/);
  assert.ok(body, 'has a body');
  assert.ok(/<section class="card">/.test(body[1]), 'the card is in the body');
  // the flow's DOM hooks — connect.js glues to these — all still exist
  for (const id of ['connect', 'connect-state', 'notice', 'device-dot']) {
    assert.ok(new RegExp(`id="${id}"`).test(html), `#${id} exists`);
  }
});

test('US-1712 the connect.js flow logic is untouched (chooser gesture, retry, pair_device)', async () => {
  const js = await read('src/popup/connect.js');
  assert.ok(js.includes('createConnectFlow'), 'still exports the flow');
  assert.ok(js.includes('requestDevice'), 'gesture-bound chooser kept');
  assert.ok(js.includes("NotFoundError"), 'dismissed-chooser retry kept');
  // the chooser entry drives pair_device adoption (pairing.js: call('pair_device'))
  assert.ok(js.includes('pairing.connect()'), 'adopts the chosen device via pairing.connect()');
  const pairing = await read('src/popup/pairing.js');
  assert.ok(pairing.includes("call('pair_device')"), 'pair_device adoption kept');
});

test('US-1712 build copies connect.css into dist (regression: a missing copy 404s the page)', async () => {
  const build = await read('build.mjs');
  const list = build.match(new RegExp('\\[[^\\]]*connect\\.css[^\\]]*\\]'));
  assert.ok(list, 'build.mjs lists connect.css in the verbatim-copy array');
});
