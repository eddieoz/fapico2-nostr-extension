// US-1710 — the prompt's identity line: which key will answer. A client
// that omits event.pubkey (the common naive case) gets signed under the
// active slot silently — this line is the one identity signal at the
// moment the user makes the decision. Pure renderer; the caller owns the
// graded degradation (slot-only when the keys fetch failed, omitted when
// even the slot read failed) and the never-an-error rule: the line is
// advisory context, the device touch is the consent.
import { npubBech32 } from '../popup/keys.js';

export function identityLine(slot, keys) {
  if (!Number.isInteger(slot) || slot < 0 || slot > 7) return null;
  if (!Array.isArray(keys)) return `with the key in slot ${slot}`;
  const k = keys.find((r) => r.idx === slot);
  if (!k) return 'no active key is set on the device';
  const npub = npubBech32(k.pubkey);
  return `with ${npub.slice(0, 20)}…${npub.slice(-4)} (slot ${slot})`;
}
