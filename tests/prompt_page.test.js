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

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFile(join(root, p), 'utf8');

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

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
