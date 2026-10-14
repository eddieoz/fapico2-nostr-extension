// US-1703/US-1705 — the popup's pure key logic: import-secret decoding and
// validation (all local, before any device call), npub rendering, and the
// label byte-length rule. No DOM, no chrome — node --test drives this.

import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { bech32 } from '@scure/base';
import { getPublicKey } from 'nostr-tools';

/** hex npub → bech32 npub1… (the nostr-tools the cross-check suite carries). */
export function npubBech32(hexNpub) {
  return bech32.encode('npub', bech32.toWords(hexToBytes(hexNpub)));
}

export const SLOTS = 8;

/** US-1703: the home-screen model — one row per identity, occupancy at a
 *  glance against the 8 slots. */
export function renderKeysModel(keys, { slots = SLOTS } = {}) {
  const rows = keys.map((k) => ({
    idx: k.idx,
    flags: k.flags,
    npub: k.pubkey,
    npubBech32: npubBech32(k.pubkey),
    label: k.label || '',
    free: false,
  }));
  const free = [];
  for (let i = 0; i < slots; i++) {
    if (!rows.some((r) => r.idx === i)) free.push(i);
  }
  return { rows, free, occupied: rows.length, slots };
}

/** US-1710 — the active-key model: the ONE render source for the popup's
 *  strip and radios. The stored slot is validated against device truth
 *  (the keys list); an unoccupied stored slot renders as nothing selected
 *  plus the actionable strip line — never trusted blindly. */
export function activeKeyModel(keys, activeSlot, { slots = SLOTS } = {}) {
  const { rows } = renderKeysModel(keys, { slots });
  const active = rows.find((r) => r.idx === activeSlot) ?? null;
  return {
    active,
    strip: active
      ? `active key: ${active.npubBech32.slice(0, 20)}…${active.npubBech32.slice(-4)} (slot ${active.idx})`
      // US-1716 — at zero keys the strip says nothing is active without
      // demanding an impossible pick (there is nothing to pick yet).
      : 'no active key yet',
  };
}

/** US-1729 — the delete-confirm's naming line, extracted pure so the three
 *  facts the user needs to RECOGNISE the key (the name it has — label or
 *  "slot N"; the truncated npub; the slot) and the active-key sentence are
 *  testable without the DOM. Presentation only: the firmware's full-npub echo
 *  check (worker delete_key + the popup's mismatched-echo catch) is untouched. */
export function deleteConfirmModel(row, activeSlot) {
  const npub = npubBech32(row.pubkey);
  const clipped = npub.length > 24 ? `${npub.slice(0, 20)}…${npub.slice(-4)}` : npub;
  const labeled = !!row.label;
  return {
    // The name the user knows: the label, or the slot number when unlabeled —
    // the slot is never dropped even though the truncated npub stands in for
    // the full identity (the truncated npub never disappears entirely).
    name: labeled ? `“${row.label}”` : `slot ${row.idx}`,
    npub: clipped,
    slot: row.idx,
    whereClause: labeled ? ` (slot ${row.idx})` : '',
    activeSentence: row.idx === activeSlot
      ? 'This is your active key — after deleting, the active key resets to slot 0.'
      : null,
  };
}

/**
 * US-1705 — decode/validate the pasted secret LOCALLY, before the touch:
 * `nsec1…` (bech32) or a 64-hex-char scalar. Returns {scalarHex, npubHex,
 * npubBech32}. Throws typed errors whose messages never contain any part of
 * the input (the scrub rule): the message names the problem, not the paste.
 */
export function decodeImportSecret(input) {
  const raw = String(input ?? '').trim();
  if (raw.length === 0) {
    throw importError('BAD_INPUT', 'paste an nsec or a 64-character hex scalar');
  }
  let scalarBytes = null;
  if (/^nsec1/i.test(raw)) {
    try {
      const decoded = bech32.decode(raw.toLowerCase(), 1000);
      if (decoded.prefix !== 'nsec') throw new Error('prefix');
      scalarBytes = new Uint8Array(bech32.fromWords(decoded.words));
    } catch {
      throw importError('BAD_NSEC', 'that nsec does not decode — check for a truncated or mistyped paste');
    }
  } else if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    scalarBytes = hexToBytes(raw.toLowerCase());
  } else {
    throw importError(
      'BAD_INPUT',
      'the import takes an nsec… or a 64-hex-character scalar — that paste is neither',
    );
  }
  if (scalarBytes.length !== 32) {
    throw importError('BAD_SCALAR', 'the secret scalar must decode to exactly 32 bytes');
  }
  const scalarHex = bytesToHex(scalarBytes);
  // Zero the working buffer (best-effort, documented): the scalar was in a
  // transient we control; JS cannot guarantee the wipe, and the UI says so.
  scalarBytes.fill(0);
  return {
    scalarHex,
    npubHex: getPublicKey(hexToBytes(scalarHex)),
    // Derived npub for the confirm step: "this imports the key that
    // publishes as npub1…".
  };
}

function importError(code, message) {
  const err = new Error(message);
  err.name = 'SignerError';
  err.code = code;
  return err;
}

/** US-1706 — the label rule: 32 BYTES of UTF-8, not 32 characters. */
export function validateLabel(label) {
  const bytes = new TextEncoder().encode(String(label ?? ''));
  if (bytes.length > 32) {
    throw importError('LABEL_TOO_LONG', `the label is ${bytes.length} bytes of UTF-8 — the device takes at most 32`);
  }
  return bytes;
}

/** US-1704/US-1707 — the SW vocabulary the screens render, derived from the
 *  single source of truth (the worker's error map — one table, both sides
 *  of the port bundle it). */
import { SW_ERROR_MAP } from '../worker/error-map.js';
export const SW_WORDS = Object.fromEntries(
  Object.entries(SW_ERROR_MAP).map(([sw, v]) => [Number(sw), v.message]),
);
