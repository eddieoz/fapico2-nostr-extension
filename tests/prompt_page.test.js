// US-1718 — the prompt's request block is ONE sentence: the worker's preview
// (the specific thing being asked) as the headline, with the raw method name
// as a small chip, and the old generic "This site wants to …" METHOD_WORDS
// sentence is gone. No jsdom in this repo, so the pure renderer is asserted
// directly and the page/JS/CSS are parsed as text (the DOM-hook facts are all
// that a render would prove here).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requestRender } from '../src/prompt/request-render.js';
import { rememberCopy } from '../src/prompt/remember-copy.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFile(join(root, p), 'utf8');

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** The first top-level `selector { ... }` block whose selector matches `re`. */
function block(css, re) {
  const m = css.match(new RegExp(`${re.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([\\s\\S]*?)\\}`));
  return m ? m[1] : null;
}

test('US-1718 the preview is the headline and the raw method is the chip', () => {
  const r = requestRender('signs a short text note — "hi"', 'sign_event');
  assert.equal(r.headline, 'signs a short text note — "hi"');
  assert.equal(r.chip, 'sign_event');
});

test('US-1718 an unknown method (no preview) renders the raw name as the headline — never empty', () => {
  const r = requestRender('', 'sign_thing');
  assert.equal(r.headline, 'sign_thing');
  assert.equal(r.chip, 'sign_thing');
});

test('US-1718 a method with neither preview nor name still fills the headline', () => {
  const r = requestRender('', '');
  assert.equal(r.headline, 'unknown');
  assert.notEqual(r.headline, '');
});

test('US-1718 the generic METHOD_WORDS sentence is gone from prompt.js', async () => {
  const js = await read('src/prompt/prompt.js');
  assert.ok(!/sign a Nostr event with your device key/.test(js), 'no METHOD_WORDS generic sentence');
  assert.ok(!/This site wants to/.test(js), 'no "This site wants to" wrapper');
  assert.ok(!/METHOD_WORDS/.test(js), 'the METHOD_WORDS map is removed');
});

test('US-1718 prompt.js drives the chip and headline hooks from requestRender', async () => {
  const js = await read('src/prompt/prompt.js');
  assert.ok(/import \{ requestRender \} from '\.\/request-render\.js'/.test(js), 'imports the pure renderer');
  assert.ok(/\$\('method-chip'\)\.textContent = render\.chip/.test(js), 'the chip hook is set from the renderer');
  assert.ok(/\$\('headline'\)\.textContent = escapeHtml\(render\.headline\)/.test(js), 'the headline hook is set (escaped) from the renderer');
});

test('US-1718 prompt.html carries the chip and headline hooks inside the request block', async () => {
  const html = await read('src/prompt/prompt.html');
  assert.ok(/id="method-chip"/.test(html), 'the chip hook exists');
  assert.ok(/id="headline"/.test(html), 'the headline hook exists');
  assert.ok(/id="wants"/.test(html), 'the request block wrapper is kept');
});

test('US-1718 prompt.css styles the chip as a neutral tag, not an amber sentence', async () => {
  const css = stripComments(await read('src/prompt/prompt.css'));
  assert.ok(/\.method-chip\s*\{/.test(css), 'the chip rule exists');
  assert.ok(!/\.what\s*\{/.test(css), 'the old .what sentence span is gone');
});

// US-1719 — the identity row must not shift the buttons: it reserves one line
// always (min-height, and a hidden identity stays in flow) and reads advisory.
test('US-1719 the identity row reserves one line even when omitted — never drops out of flow', async () => {
  const css = stripComments(await read('src/prompt/prompt.css'));
  const rule = block(css, '\.request-identity');
  assert.ok(rule, 'the identity rule exists');
  assert.ok(/min-height:/.test(rule), 'a min-height reserves the line in every state');
  const hidden = css.match(/\.request-identity\[hidden\]\s*\{([^}]*)\}/);
  assert.ok(hidden, 'the [hidden] override selector exists');
  assert.ok(hidden && !/display:\s*none/.test(hidden[1]), 'a hidden identity stays in flow (space reserved)');
});

test('US-1719 the identity row is advisory — one step stronger than dim, never an alarm', async () => {
  const css = stripComments(await read('src/prompt/prompt.css'));
  const rule = block(css, '\.request-identity');
  assert.ok(/color:\s*var\(--ink\)/.test(rule), 'stronger than the --ink-dim chassis text');
  assert.ok(!/var\(--err\)|var\(--amber\)/.test(rule), 'no error/amber alarm styling');
});

// US-1720 — the remember copy is one short sentence naming the site but keeps
// BOTH clauses the store actually delivers, and never over-promises. The pure
// renderer is asserted directly; the wiring (checkbox gates only `remember`,
// the touch footnote stays) is asserted on the source.
test('US-1720 remember copy names the site and pins both load-bearing clauses', () => {
  const c = rememberCopy('snort.social');
  assert.ok(c.includes('snort.social'), 'names the site');
  assert.ok(c.includes('for this action only'), 'clause 1: this site, for this action only');
  assert.ok(c.includes('the device touch is still required every time'), 'clause 2: touch still required every time');
});

test('US-1720 remember copy never promises "never asked again" beyond what the store delivers', () => {
  assert.ok(!/asked again|never asked|not be asked/i.test(rememberCopy('snort.social')), 'no over-promise');
  assert.ok(/this site/.test(rememberCopy('')), 'an unknown host falls back without a false site name');
});

test('US-1720 the over-promising "asked again" copy is gone; the touch footnote stays', async () => {
  const html = await read('src/prompt/prompt.html');
  assert.ok(!/will not be asked again|not be asked again|never asked/i.test(html), 'the over-promising copy is gone');
  assert.ok(/is the final consent/i.test(html), 'the touch = final-consent footnote is unchanged');
});

test('US-1720 the checkbox still gates only `remember` — the decision payload is unchanged', async () => {
  const js = await read('src/prompt/prompt.js');
  const reads = js.match(/\$\('remember'\)\.checked/g) ?? [];
  assert.equal(reads.length, 1, 'the checkbox value feeds exactly one field');
  assert.ok(/remember:\s*\$\('remember'\)\.checked/.test(js), 'and that field is `remember`');
});
