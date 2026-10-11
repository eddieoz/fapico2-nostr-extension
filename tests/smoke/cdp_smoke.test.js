// US-1708 — the smoke gate as a node --test case: it runs the CDP smoke
// (tests/smoke/run.js) when Chrome is available, and skips cleanly when
// CHROME_PATH is unset (the flag gate). Locally with Chrome present it runs
// like CI would — a failure is a release blocker either way.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

test('US-1708 the CDP smoke gate: window.nostr installs on a real Chrome and answers typed', { timeout: 90_000 }, async () => {
  if (!process.env.CHROME_PATH) {
    const maybe = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
    const { existsSync } = await import('node:fs');
    for (const p of maybe) {
      if (existsSync(p)) {
        process.env.CHROME_PATH = p;
        break;
      }
    }
  }
  if (!process.env.CHROME_PATH) {
    console.log('smoke: skipped — no Chrome available');
    return;
  }
  const output = await new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [join(here, 'run.js')],
      { timeout: 80_000, env: process.env, cwd: join(here, '..', '..') },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`${stdout}${stderr}`.trim() || err.message));
        else resolve(stdout);
      },
    );
  });
  assert.match(output, /smoke: PASS/);
  assert.match(output, /window\.nostr is an object in the MAIN world/);
  assert.match(output, /the surface is exactly the NIP-07 trio \+ nip44/);
  assert.match(output, /rejects DeviceAbsentError \(typed, loud\)/);
});
