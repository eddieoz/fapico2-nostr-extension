// US-1717 — verify-before-flash: the export round trip. On old firmware
// (v0.2.0 and friends, where EXPORT_KEY still answers), the extension
// encourages one round trip BEFORE the new image is flashed: import the
// exported scalar back into a free slot, confirm the derived public key is
// the exported identity's, then DELETE the test copy. After flashing, a
// corrupt export is unverifiable forever — there is no second source left.
//
// The helper is deliberately dull device choreography over the serialized
// owner, so the tests drive it against the mock device ("the emulator") and
// the popup against the real board. Two copies on two media is advice, not
// code — the helper returns the sentence to render next to the verified
// scalar.

import { NOSTR_CMD, SW } from '../core/ctaphid.js';
import { SwError, SignerError } from '../core/seams.js';

export const ROUND_TRIP_ADVICE =
  'verified — keep two copies of the secret on two different media before flashing';

/** A free slot: the first index 0..7 no live identity occupies, read from
 *  LIST_KEYS' own answer (n(1), then idx(1) ‖ flags(1) ‖ npub(32) ‖
 *  label_len(1) ‖ label per key) — the same shape the applet answers with.
 *  Returns null when the board is full. */
export function firstFreeSlot(data) {
  if (!data || data.length < 1) throw new SignerError('DEVICE_REPLY_MALFORMED', 'LIST_KEYS answered with a short body');
  const n = data[0];
  let off = 1;
  const taken = new Set();
  for (let i = 0; i < n; i++) {
    if (off + 2 > data.length) throw new SignerError('DEVICE_REPLY_MALFORMED', 'LIST_KEYS answered with a short record');
    taken.add(data[off]);
    const npubLen = 32;
    off += 2 + npubLen;
    if (off >= data.length) throw new SignerError('DEVICE_REPLY_MALFORMED', 'LIST_KEYS answered with a short record');
    off += 1 + data[off];
  }
  for (let slot = 0; slot <= 7; slot++) {
    if (!taken.has(slot)) return slot;
  }
  return null;
}

/**
 * The round trip. `device` is the serialized owner ({run}); `scalarHex` is
 * the exported secret, `npubHex` the exported identity's public key — both
 * hex, the shapes the popup already holds. Every step's device answer is
 * validated; a mismatch is typed, loud, and happens BEFORE any flashing.
 *
 * Returns { verified: true, slot, advice }; throws typed on every failure
 * path (no free slot, echo mismatch, delete refusal).
 */
export async function verifyExportRoundTrip(device, { scalarHex, npubHex }) {
  const run = async (cmd, idx, arg) => {
    const { sw, data } = await device.run(cmd, idx, arg);
    if (sw !== SW.OK) throw new SwError('EXPORT_ROUND_TRIP', sw);
    return data;
  };

  const listData = await run(NOSTR_CMD.LIST_KEYS, 0, new Uint8Array(0));
  const slot = firstFreeSlot(listData);
  if (slot === null) {
    throw new SignerError(
      'ROUND_TRIP_NO_SLOT',
      'the round trip needs one free slot on the board — delete an identity first (do not flash yet)',
    );
  }

  // The scalar rides the import path as 32 raw bytes.
  if (!/^[0-9a-f]{64}$/i.test(scalarHex ?? '')) {
    throw new SignerError('BAD_SCALAR', 'the exported secret is not 32 hex bytes');
  }
  const scalar = new Uint8Array(32);
  for (let i = 0; i < 32; i++) scalar[i] = parseInt(scalarHex.slice(i * 2, i * 2 + 2), 16);

  // Import into the TEST slot; the echo must name the exported identity.
  const imported = await run(NOSTR_CMD.IMPORT_KEY, slot, scalar);
  if (imported.length < 32) {
    throw new SignerError('DEVICE_REPLY_MALFORMED', 'IMPORT_KEY answered 9000 with a short npub');
  }
  const echoed = Array.from(imported.subarray(0, 32), (b) => b.toString(16).padStart(2, '0')).join('');
  if (npubHex && echoed !== npubHex.toLowerCase()) {
    // The test copy still stands — name the cleanup, never leave the
    // duplicate behind.
    try {
      await run(NOSTR_CMD.DELETE_KEY, slot, new Uint8Array(0));
    } catch {
      /* the user deletes it from the keys screen; the mismatch is the story */
    }
    throw new SignerError(
      'ROUND_TRIP_MISMATCH',
      'the round trip found a mismatch — the export is not verified. Do not flash; delete the test copy and export again',
    );
  }

  // Confirmed: DELETE the test copy. The echo must name the test slot's
  // identity again — the same guard the destructive-path tests pin.
  const deleted = await run(NOSTR_CMD.DELETE_KEY, slot, new Uint8Array(0));
  if (deleted.length < 32) {
    throw new SignerError('DEVICE_REPLY_MALFORMED', 'DELETE_KEY answered 9000 with a short npub');
  }
  const deletedEcho = Array.from(deleted.subarray(0, 32), (b) => b.toString(16).padStart(2, '0')).join('');
  if (npubHex && deletedEcho !== npubHex.toLowerCase()) {
    throw new SignerError(
      'STORE_FAULT',
      'the delete echoed a different identity than the test copy — store fault, not success',
    );
  }

  return { verified: true, slot, advice: ROUND_TRIP_ADVICE };
}
