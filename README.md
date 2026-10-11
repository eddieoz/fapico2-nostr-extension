# fapico2-nostr-extension

A Nostr-only, hardware-first browser extension: every `window.nostr` key
operation is performed by a **fapico2 board** (RP2350 running the
[`fapico2`](https://github.com/eddieoz/fapico2) firmware's Nostr applet) over
WebHID. Keys never live in the browser; every signature, NIP-44
encrypt/decrypt and key-set change is consented by a **physical touch** on the
device.

Status: **design approved, implementation not started.** The approved design
is [docs/design.md](docs/design.md); the TDD/BDD epic that implements it is
`docs/tasks/EPIC-nostr-extension.md` (private, gitignored, the `fapico2`
workspace convention).

## Shape

- MV3, service-worker-centric: the worker is the **only** owner of the device
  (the firmware serves one transaction at a time and refuses a second vendor
  request while a touch window is parked).
- Page surface: `getPublicKey`, `signEvent`, `listKeys`, `nip44.encrypt`,
  `nip44.decrypt` — the NIP-07 trio plus device NIP-44.
- Consent: per-site grant popup with optional "remember this site"; the device
  touch is always required on top (firmware-enforced).
- MIT. The hardware client core is ported verbatim from OpenXrypt `feat/nostr`
  (MIT, © Edilson Osorio Jr) — `ctaphid.js`, `seams.js`, `loudness.js` and
  their 78-test suite.

## Hardware contract

The extension speaks the vendor protocol documented in the firmware tree:
`firmware/src/nostr_wire.rs` (commands `0x40`–`0x4A`, CBOR envelope
`[idx, arg]` → `{1: sw, 2?: data}`, D13 status vocabulary), CTAPHID framing per
`docs/ctap2-hid-framing.md`, on USB HID interface 3 (usage page `0xFF00`,
usage `0x01`). The protocol-fixture test in this repo pins those bytes so the
two trees cannot drift silently.
