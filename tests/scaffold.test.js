// US-1689 — the scaffold gate: the build output exists, the manifest parses,
// every file the manifest names exists in dist/, and there is **no
// world: "MAIN" entry** — the invariant that makes US-1696 (script-tag
// injection) necessary, asserted here so it can never regress into the
// Chrome same-file-two-worlds dedup bug.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

const exists = async (p) => {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
};

test('US-1689 the build emitted a loadable MV3 bundle', async () => {
  assert.ok(await exists(join(dist, 'manifest.json')), 'dist/manifest.json');
  for (const chunk of ['worker.js', 'bridge.js', 'provider.js', 'popup.js', 'prompt.js', 'ceremony.js']) {
    assert.ok(await exists(join(dist, chunk)), `dist/${chunk}`);
  }
});

test('US-1689 the manifest parses and every entry it names exists in dist/', async () => {
  const manifest = JSON.parse(await readFile(join(dist, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);

  for (const [entry, files] of Object.entries({
    'background.service_worker': [manifest.background?.service_worker],
    'action.default_popup': [manifest.action?.default_popup],
    'content_scripts[].js': manifest.content_scripts?.flatMap((cs) => cs.js) ?? [],
    'web_accessible_resources[].resources':
      manifest.web_accessible_resources?.flatMap((war) => war.resources) ?? [],
    'icons': Object.values(manifest.icons ?? {}),
  })) {
    for (const file of files) {
      assert.ok(file, `${entry} names a file`);
      assert.ok(await exists(join(dist, file)), `${entry} -> dist/${file} exists`);
    }
  }

  for (const page of ['popup.html', 'prompt.html']) {
    assert.ok(await exists(join(dist, page)), `dist/${page} exists`);
  }
});

test('US-1689 the manifest declares no world: "MAIN" content script (the US-1696 invariant)', async () => {
  const manifest = JSON.parse(await readFile(join(dist, 'manifest.json'), 'utf8'));
  for (const cs of manifest.content_scripts ?? []) {
    assert.notEqual(cs.world, 'MAIN', 'a world: MAIN entry would trip the Chrome same-file-two-worlds dedup bug — the provider is script-tag injected instead');
  }
  // And the source manifest — the one a future edit is most likely to
  // touch — carries the same invariant.
  const source = JSON.parse(await readFile(join(root, 'src', 'manifest.json'), 'utf8'));
  for (const cs of source.content_scripts ?? []) {
    assert.notEqual(cs.world, 'MAIN');
  }
});

test('US-1689 the committed dist/ tree is complete (icons included)', async () => {
  const icons = await readdir(join(dist, 'icons'));
  for (const want of ['icon16.png', 'icon48.png', 'icon128.png']) {
    assert.ok(icons.includes(want), `dist/icons/${want}`);
  }
});
