// US-1750 — window_nostr.js exports only the two live error serializers. The
// dead half (installPageNostr, attachNostrBridge, createNostrBridge, the
// PAGE_METHODS table, and the second marker openxrypt:nostr:1) was never wired
// into any bundle — only serializeBridgeError/reviveBridgeError are imported
// (by provider.js and bridge.js). Two markers, one dead, is a rot hazard; the
// live marker fapico:nostr:1 (in shared/protocol.js) is the sole marker in src/.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const mod = await import('../src/core/window_nostr.js');

test('US-1750 window_nostr.js exports exactly the two error serializers', () => {
  assert.deepEqual(
    Object.keys(mod).sort(),
    ['reviveBridgeError', 'serializeBridgeError'],
    'no installPageNostr/attachNostrBridge/createNostrBridge/NOSTR_MARKER',
  );
});

test('US-1750 no src/ file carries the dead openxrypt:nostr marker', async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const coreDir = join(here, '..', 'src');
  const hits = [];
  async function walk(dir) {
    for (const name of await readdir(dir)) {
      const p = join(dir, name);
      const { stat } = await import('node:fs/promises');
      const s = await stat(p);
      if (s.isDirectory()) await walk(p);
      else if (name.endsWith('.js')) {
        const text = await readFile(p, 'utf8');
        if (text.includes('openxrypt:nostr')) hits.push(p);
      }
    }
  }
  await walk(coreDir);
  assert.deepEqual(hits, [], 'grep of src/ for openxrypt:nostr is empty');
});
