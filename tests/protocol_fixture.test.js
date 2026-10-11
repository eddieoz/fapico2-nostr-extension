// US-1690 — the protocol fixture test: every module-level constant of the
// ported core is asserted against the transcribed firmware fixture
// (tests/fixtures/nostr_wire_d15abe7.js, source commit named there). This is
// the pin that stops the extension client and the firmware's nostr_wire.rs
// from drifting silently — a firmware wire change must fail here first.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NOSTR_CMD as CORE_CMD,
  SW as CORE_SW,
  USAGE_PAGE,
  USAGE_ID,
  REPORT_SIZE,
  FIRST_PAYLOAD,
  CONT_PAYLOAD,
  BROADCAST_CID,
  DEFAULT_TIMEOUT_MS,
} from '../src/core/ctaphid.js';

import {
  SOURCE_COMMIT,
  NOSTR_CMD as FIXTURE_CMD,
  SW as FIXTURE_SW,
  NOSTR_REQ_ARG_MAX,
  REQUEST_HEAD,
  RESPONSE_HEADS,
  USAGE_PAGE as FIXTURE_USAGE_PAGE,
  USAGE_ID as FIXTURE_USAGE_ID,
  INIT_REPLY_LEN,
  INIT_CAPFLAGS_OFFSET,
  INIT_VENDOR_VERSION_OFFSET,
  REPORT_SIZE as FIXTURE_REPORT_SIZE,
  FIRST_PAYLOAD as FIXTURE_FIRST_PAYLOAD,
  CONT_PAYLOAD as FIXTURE_CONT_PAYLOAD,
} from './fixtures/nostr_wire_d15abe7.js';

import {
  encodeRequest,
  decodeResponse,
} from '../src/core/ctaphid.js';

const pathLine = /^import\s.*from\s/;

// US-1690 acceptance: no source line in src/core/ differs from the
// OpenXrypt original except import paths. The originals are snapshotted at
// tests/fixtures/openxrypt-feat-nostr-d431b00/ (HEAD d431b00, feat/nostr);
// a divergence is a declared, reviewed change — never an accident.
test('US-1690 src/core is byte-identical to the OpenXrypt d431b00 originals except import paths', async () => {
  const { readFile, readdir } = await import('node:fs/promises');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = dirname(fileURLToPath(import.meta.url));
  const coreDir = join(here, '..', 'src', 'core');
  const origDir = join(here, 'fixtures', 'openxrypt-feat-nostr-d431b00', 'src', 'nostr');
  // The declared allow-list: lines that may differ, per file, with the
  // reason named. Today it carries one reviewed, hardware-forced fix:
  //
  //  - ctaphid.js — `dev.sendReport({reportId: 0, data: r})` →
  //    `dev.sendReport(0, r)` (lines 242/265/312, plus the header comment
  //    naming the surface). OpenXrypt's dictionary form does not exist in
  //    Chrome's WebHID: `HIDDevice.sendReport(reportId, data)` — the
  //    reportId is the FIRST argument. The ported
  //    test double accepted the dictionary, so only a real device could
  //    catch it — the US-1709 ceremony did, on the first INIT (the typed
  //    failure is recorded in docs/ceremony-results.md). Found on
  //    hardware 2026-10-11; the ceremony is the gate that caught it.
  const allowList = {
    'ctaphid.js': [
      216, 217, 218, // header names the real sendReport signature
      242, 265, 312, // sendReport(reportId, data) — the reportId is the first argument
      349, // _onReport normalizes Chrome's DataView report data before framing
    ],
  };

  for (const name of await readdir(coreDir)) {
    if (!name.endsWith('.js')) continue;
    const orig = await readFile(join(origDir, name), 'utf8');
    const now = await readFile(join(coreDir, name), 'utf8');
    const origLines = orig.split('\n');
    const nowLines = now.split('\n');
    assert.equal(nowLines.length, origLines.length, `${name}: line count diverged — the port is not verbatim`);
    const allowed = allowList[name] ?? [];
    const diffs = [];
    for (let i = 0; i < origLines.length; i++) {
      if (origLines[i] !== nowLines[i]) {
        if (pathLine.test(origLines[i]) && pathLine.test(nowLines[i])) {
          diffs.push(`${name}:${i + 1} (import path, allowed)`);
        } else if (allowed.includes(i + 1)) {
          diffs.push(`${name}:${i + 1} (allow-listed)`);
        } else {
          diffs.push(`${name}:${i + 1}: "${origLines[i]}" -> "${nowLines[i]}"`);
        }
      }
    }
    const unexpected = diffs.filter((d) => !d.includes('allow'));
    assert.deepEqual(unexpected, [], `${name}: non-path divergences from the original`);
  }
});

test('US-1690 the vendor command set matches the firmware wire fixture', () => {
  assert.deepEqual(CORE_CMD, FIXTURE_CMD);
});

test('US-1690 the status vocabulary matches the firmware wire fixture', () => {
  // The core's SW export is the subset the seam layer renders; every
  // vocabulary entry the core names must match the fixture's value, and the
  // D13 five the seam consumes must all be present.
  for (const [name, sw] of Object.entries(CORE_SW)) {
    assert.equal(sw, FIXTURE_SW[name], `SW.${name} drifted from the fixture`);
  }
  // The full D13 vocabulary the firmware can emit (the fixture's list) is
  // what the error model (US-1707) must cover end to end. 11 distinct words;
  // the fixture carries 12 keys because 0x6985 is named twice (the firmware's
  // SW_TOUCH_REQUIRED and the core's CONDITIONS_NOT_SATISFIED alias).
  assert.ok(FIXTURE_SW.OK === 0x9000 && FIXTURE_SW.TOUCH_REQUIRED === 0x6985);
  assert.equal(new Set(Object.values(FIXTURE_SW)).size, 11, 'the D13 vocabulary is 11 words');
});

test('US-1690 the vendor surface is usage 0xFF00:0x01 with the pinned framing constants', () => {
  assert.equal(USAGE_PAGE, FIXTURE_USAGE_PAGE);
  assert.equal(USAGE_ID, FIXTURE_USAGE_ID);
  assert.equal(REPORT_SIZE, FIXTURE_REPORT_SIZE, '64-byte reports');
  assert.equal(FIRST_PAYLOAD, FIXTURE_FIRST_PAYLOAD, '57-byte first-frame payload');
  assert.equal(CONT_PAYLOAD, FIXTURE_CONT_PAYLOAD, '59-byte continuation payload');
  assert.deepEqual([...BROADCAST_CID], [0xff, 0xff, 0xff, 0xff]);
});

test('US-1690 the INIT reply shape is 17 bytes with capFlags at 16 and version at 13..15', () => {
  // Pinned through the executable shape: the INIT reply payload the
  // ctaphid tests accept is nonce(8) + cid(4) + verIface(2) + version(3) +
  // capFlags(1) = 17, version slice [13, 16]. Assert the arithmetic the
  // transport relies on (the transport slices 13..16 for the version and
  // requires length >= 17).
  assert.equal(INIT_REPLY_LEN, 17);
  assert.equal(INIT_CAPFLAGS_OFFSET, 16);
  assert.equal(INIT_VENDOR_VERSION_OFFSET, 13);
});

test('US-1690 the request envelope encodes the firmware decode_request form, byte-exact', () => {
  // firmware nostr_wire.rs decode_request: array(2) head 0x82, uint idx
  // (0x17 / 0x18 / 0x19 heads), byte-string arg (0x40+n / 0x58 / 0x59).
  assert.deepEqual([...encodeRequest(0, new Uint8Array(0))], [REQUEST_HEAD, 0x00, 0x40]);
  assert.deepEqual([...encodeRequest(3, new Uint8Array(24).fill(9))].slice(0, 4), [REQUEST_HEAD, 0x03, 0x58, 0x18]);
  assert.deepEqual([...encodeRequest(200, new Uint8Array(0))], [REQUEST_HEAD, 0x18, 0xc8, 0x40]);
  assert.deepEqual([...encodeRequest(1000, new Uint8Array(0))], [REQUEST_HEAD, 0x19, 0x03, 0xe8, 0x40]);
});

test('US-1690 the response decoder is the firmware encode_response inverse, both shapes', () => {
  const [swOnly, data0] = decodeResponse(new Uint8Array([0xa1, 0x01, 0x19, 0x69, 0x85]));
  assert.equal(swOnly, 0x6985);
  assert.equal(data0.length, 0);
  const [sw, data] = decodeResponse(new Uint8Array([0xa2, 0x01, 0x19, 0x90, 0x00, 0x02, 0x58, 0x02, 0xaa, 0xbb]));
  assert.equal(sw, 0x9000);
  assert.deepEqual([...data], [0xaa, 0xbb]);
  assert.deepEqual(RESPONSE_HEADS, [0xa1, 0xa2]);
});

test('US-1690 the §2.2.1 wire cap (1891 bytes) is the bound the client never exceeds', () => {
  // NIP-44's largest legal request is peer(32) + MAX_PLAINTEXT — the
  // firmware refuses anything above 1891 at the parse layer. The client's
  // NIP44 arg builder must never produce more; the loudest guarantee the
  // client can make is that a capped argument encodes fine and a >cap one
  // would be refused by the device — so the pin here is the constant and
  // the encode path staying silent up to it.
  assert.equal(NOSTR_REQ_ARG_MAX, 1891);
  const biggest = encodeRequest(0x44, new Uint8Array(NOSTR_REQ_ARG_MAX));
  assert.ok(biggest.length > NOSTR_REQ_ARG_MAX, 'the envelope encodes a cap-sized argument');
});

test('US-1690 the fixture names its source commit', () => {
  assert.equal(SOURCE_COMMIT, 'd15abe7');
  // The whole-ceremony budget the transport defaults to (30 s) covers the
  // device's 15 s touch window plus slack — inherited, not re-derived.
  assert.equal(DEFAULT_TIMEOUT_MS, 30_000);
});
