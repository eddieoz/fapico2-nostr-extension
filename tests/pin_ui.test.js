// US-1707 — the capability gate and the three UI states, derived from
// GET_INFO and nothing else: absence of CAP_PIN_MGMT hides every PIN UI,
// INFO_FLAGS bit1 is the lock indicator, bit0 drives the settings row, and
// the GENERATE flow keeps the no-backup warning.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EXPORT_REMOVED_NOTICE, pinUi, UNLOCKED_HINT } from '../src/worker/pin_flow.js';

const NEW_NO_PIN = { caps: 0x0007, flags: 0x00 };
const NEW_LOCKED = { caps: 0x0007, flags: 0x01 };
const NEW_UNLOCKED = { caps: 0x0007, flags: 0x03 };
const OLD_FW = { caps: 0x0003, flags: 0x00 }; // v0.2.0

test('US-1707 old firmware hides every PIN UI and its export flow is untouched', () => {
  const ui = pinUi(OLD_FW);
  assert.equal(ui.showPinUi, false);
  assert.equal(ui.settingsRow, null);
  assert.equal(ui.lockIndicator, null);
  assert.equal(ui.exportNotice, null, 'a v0.2.0 board CAN export — the removal notice is not its sentence');
});

test('US-1707 a custody board carries the export-removed notice even when PIN-less', () => {
  const ui = pinUi(NEW_NO_PIN);
  assert.equal(ui.showPinUi, true);
  assert.equal(ui.exportNotice, EXPORT_REMOVED_NOTICE);
  assert.equal(ui.settingsRow, 'offer');
});

test('US-1707 INFO_FLAGS bit1 is the lock indicator; bit0 drives the settings row', () => {
  assert.equal(pinUi(NEW_LOCKED).lockIndicator, null);
  assert.equal(pinUi(NEW_LOCKED).settingsRow, 'manage');
  assert.equal(pinUi(NEW_UNLOCKED).lockIndicator, UNLOCKED_HINT);
  assert.match(UNLOCKED_HINT, /until the board restarts/);
});

test('US-1707 the GENERATE flow keeps the no-backup warning (the export screen is removed)', async () => {
  const here = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'popup');
  const html = await readFile(join(here, 'popup.html'), 'utf8');
  assert.match(html, /cannot be backed up; it lives only on the device/);
  assert.ok(!/export-removed|Reveal & touch/.test(html), 'no export UI remains in the popup');
});
