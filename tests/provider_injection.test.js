// US-1696 — script-tag provider injection: the bridge appends exactly one
// <script src> tag naming the provider chunk (the web_accessible resource);
// an existing window.nostr is preserved (never-clobber decides before any
// tag is added); the manifest itself carries no world: "MAIN" entry
// (asserted in scaffold.test.js — here the structural reason is tested).

import test from 'node:test';
import assert from 'node:assert/strict';

import { injectProvider } from '../src/content/bridge.js';

/** A minimal DOM double: enough for querySelector/createElement/append. */
function fakeDoc() {
  const children = [];
  const impl = {
    head: { appendChild: (el) => children.push(el) },
    documentElement: { appendChild: (el) => children.push(el) },
    _children: children,
    querySelector(sel) {
      return children.find((el) => el.matches?.(sel)) ?? null;
    },
    createElement(tag) {
      const attrs = new Map();
      return {
        tagName: tag,
        src: null,
        setAttribute: (k, v) => attrs.set(k, v),
        getAttribute: (k) => attrs.get(k) ?? null,
        matches: (sel) => {
          if (sel === 'script[data-fapico-nostr-provider]') {
            return attrs.get('data-fapico-nostr-provider') === 'true';
          }
          return false;
        },
      };
    },
  };
  return impl;
}

function fakeWin(doc = fakeDoc()) {
  return { nostr: undefined, document: doc };
}

test('US-1696 the bridge appends exactly one script tag with the runtime URL', () => {
  const win = fakeWin();
  const url = 'chrome-extension://test-id/provider.js';
  const tag = injectProvider(win, { url });
  assert.ok(tag, 'a tag was appended');
  assert.equal(tag.src, url);
  assert.equal(tag.tagName, 'script');
  assert.equal(win.document._children.length, 1, 'exactly one tag per page');
  // Idempotent: a second init adds nothing.
  const again = injectProvider(win, { url });
  assert.equal(again, tag);
  assert.equal(win.document._children.length, 1);
});

test('US-1696 an existing window.nostr is preserved — no tag is added at all', () => {
  const win = fakeWin();
  const existing = { getPublicKey: () => 'already-here' };
  win.nostr = existing;
  const tag = injectProvider(win, { url: 'chrome-extension://test-id/provider.js' });
  assert.equal(tag, null, 'no injection when the slot is taken');
  assert.equal(win.nostr, existing);
  assert.equal(win.document._children.length, 0);
});

test('US-1696 the built manifest and the built bridge agree on the resource name', async () => {
  const { readFile } = await import('node:fs/promises');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const manifest = JSON.parse(await readFile(join(root, 'src', 'manifest.json'), 'utf8'));
  const war = manifest.web_accessible_resources.flatMap((r) => r.resources);
  assert.deepEqual(war, ['provider.js'], 'the provider chunk is the only web-accessible resource');
  assert.equal(manifest.content_scripts.length, 1, 'one content script entry');
  assert.notEqual(manifest.content_scripts[0].world, 'MAIN');
  assert.equal(manifest.content_scripts[0].run_at, 'document_start', 'injection precedes page scripts');
  // The bridge requests exactly the resource the manifest exposes.
  const bridgeSrc = await readFile(join(root, 'src/content/bridge.js'), 'utf8');
  assert.ok(bridgeSrc.includes("getURL('provider.js')"));
});
