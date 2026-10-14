// US-1731 — one vocabulary for the methods a page may be granted. The worker
// (buildPreview), the prompt, and the Sites screen each rendered these method
// names their own way — snake_case identifiers, raw method names — so the same
// grant read three different ways. This module is the single canonical map:
// the method name the worker relays → the plain words every surface shows.
// buildPreview keeps its request-specific sentences (D-UX9 makes the *vocabulary*
// canonical, not the sentences); this is the vocabulary.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PAGE_METHODS } from '../src/shared/protocol.js';
import { METHOD_WORDS, methodWord, methodWords } from '../src/shared/method-words.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFile(join(root, p), 'utf8');

test('US-1731 the map covers every page-allowed method', () => {
  for (const m of PAGE_METHODS) {
    assert.ok(METHOD_WORDS[m], `${m} has shared plain words`);
    assert.equal(typeof METHOD_WORDS[m], 'string');
    assert.notEqual(String(METHOD_WORDS[m]).trim(), '', `${m} is not blank`);
  }
});

test('US-1731 the map is exactly the page-allowed set — no drift', () => {
  assert.deepEqual([...Object.keys(METHOD_WORDS)].sort(), [...PAGE_METHODS].sort());
});

test('US-1731 the two phrases the epic pins are verbatim', () => {
  assert.equal(METHOD_WORDS.get_public_key, 'reads your public key');
  assert.equal(METHOD_WORDS.sign_event, 'signs events');
});

test('US-1731 a single method renders in plain words', () => {
  assert.equal(methodWord('get_public_key'), 'reads your public key');
  assert.equal(methodWord('sign_event'), 'signs events');
});

test('US-1731 a grant joins its methods as shared plain words, not identifiers', () => {
  assert.equal(
    methodWords(['get_public_key', 'sign_event']),
    'reads your public key, signs events',
  );
});

test('US-1731 an unknown method falls back to its raw name (never blank)', () => {
  assert.equal(methodWord('something_new'), 'something_new');
  assert.equal(methodWords(['something_new']), 'something_new');
});

test('US-1731 the module is pure data + a formatter (no DOM, no side effects)', async () => {
  const src = await read('src/shared/method-words.js');
  assert.match(src, /export\s*const\s+METHOD_WORDS/, 'exports the map');
  assert.match(src, /export\s+function\s+methodWord/, 'exports the singular formatter');
  assert.match(src, /export\s+function\s+methodWords/, 'exports the plural formatter');
  const body = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(body, /document\.|localStorage|navigator\.|postMessage/,
    'a pure formatter touches no DOM / storage / channel');
});
