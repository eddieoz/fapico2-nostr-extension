// US-1708 — the tripwire test: the smoke gate must DETECT the OpenXrypt
// manifest shape (world: "MAIN" with a duplicate file). The fixture copies
// that shape; the real manifest must pass clean.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { manifestTripwire } from './checks.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('US-1708 the OpenXrypt manifest shape trips the tripwire', async () => {
  const fixture = JSON.parse(
    await readFile(join(root, 'tests/fixtures/openxrypt-manifest-shape.json'), 'utf8'),
  );
  const trip = manifestTripwire(fixture);
  assert.ok(trip, 'the duplicate-file two-worlds shape must be detected');
  assert.match(trip, /lib\/nostr\.min\.js/);
  assert.match(trip, /MAIN/);
});

test('US-1708 this repo\'s manifest passes the tripwire clean', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  assert.equal(manifestTripwire(manifest), null);
});

test('US-1708 a two-worlds shape with DIFFERENT files is not the bug (control row)', () => {
  // The isolated bridge and the MAIN provider are different chunks here on
  // purpose — the bug is the same FILE in both worlds.
  const control = {
    content_scripts: [
      { matches: ['<all_urls>'], js: ['bridge.js'], run_at: 'document_start' },
      { matches: ['<all_urls>'], js: ['provider.js'], world: 'MAIN', run_at: 'document_start' },
    ],
  };
  assert.equal(manifestTripwire(control), null);
});
