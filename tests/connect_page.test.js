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

import { connectStateLabel, handoffDecision, createConnectFlow } from '../src/popup/connect.js';

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

// US-1734 — the connect step of the UX release gate. The page-state map, the
// first-run handoff decision, and the flow driven by a mock chooser + worker
// (no DOM): a board that grants, a returning board, and a dismissed chooser.

test('US-1734 connectStateLabel maps each state to its line, dot and class', () => {
  assert.deepEqual(connectStateLabel('connected'), {
    line: 'fapico2 board connected', dot: 'connected', lineClass: 'connect-state connected',
  });
  assert.deepEqual(connectStateLabel('busy'), {
    line: 'busy — retrying in a second', dot: 'busy', lineClass: 'connect-state waiting',
  });
  assert.deepEqual(connectStateLabel('error', 'try again'), {
    line: 'device error — try again', dot: 'error', lineClass: 'connect-state error',
  });
  assert.deepEqual(connectStateLabel('absent'), {
    line: 'no board granted yet', dot: 'absent', lineClass: 'connect-state',
  });
  assert.deepEqual(connectStateLabel('idle'), {
    line: 'no board granted yet', dot: 'absent', lineClass: 'connect-state',
  });
});

test('US-1734 an error state is distinct from absent — never the absent line', () => {
  const err = connectStateLabel('error', 'the board refused');
  assert.notEqual(err.line, 'no board granted yet');
  assert.match(err.line, /device error/);
  assert.match(err.lineClass, /connect-state error/);
});

test('US-1734 handoffDecision keeps a freshly paired zero-key board open', () => {
  assert.deepEqual(handoffDecision(0), { close: false, handoff: true });
});

test('US-1734 a returning board closes after the beat; a failed listing does not hang', () => {
  assert.deepEqual(handoffDecision(3), { close: true, handoff: false });
  assert.deepEqual(handoffDecision(null), { close: true, handoff: false });
});

test('US-1734 a connected zero-key board returns a handoff and stays open', async () => {
  let closed = false;
  const flow = createConnectFlow({
    requestDevice: async () => [{}],
    call: async (m) => (m === 'pair_device' ? { state: 'connected' } : []),
    onClose: () => { closed = true; },
  });
  const out = await flow.connect();
  assert.equal(out.state, 'connected');
  assert.equal(out.handoff, true, 'first-run handoff is flagged');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(closed, false, 'the journey board stays open — it points at the toolbar icon');
});

test('US-1734 a connected returning board closes after the beat', async () => {
  let closed = false;
  const flow = createConnectFlow({
    requestDevice: async () => [{}],
    call: async (m) => (m === 'pair_device' ? { state: 'connected' } : [{}, {}, {}]),
    onClose: () => { closed = true; },
    autoCloseMs: 5,
  });
  const out = await flow.connect();
  assert.equal(out.handoff, undefined, 'a returning board is not a handoff');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(closed, true, 'the beat fired, then the window dismissed itself');
});

test('US-1734 a dismissed chooser returns absent + cancelled and stays up to retry', async () => {
  const flow = createConnectFlow({
    requestDevice: async () => {
      throw Object.assign(new Error('no device selected'), { name: 'NotFoundError' });
    },
    call: async () => ({}),
  });
  const out = await flow.connect();
  assert.equal(out.state, 'absent');
  assert.equal(out.cancelled, true);
});
