# fapico2-nostr-extension

A Nostr-only, hardware-first browser extension: every `window.nostr` key
operation is performed by a **fapico2 board** (RP2350 running the
[`fapico2`](https://github.com/eddieoz/fapico2) firmware's Nostr applet) over
WebHID. Keys never live in the browser; every signature, NIP-44
encrypt/decrypt and key-set change is consented by a **physical touch** on the
device.

Status: **implemented** (epic `NOSTR-EXT`, US-1689..1709 — see
[docs/design.md](docs/design.md); the TDD/BDD epic is `docs/tasks/EPIC-nostr-extension.md`,
private, gitignored, the `fapico2` workspace convention).

## Shape

- MV3, service-worker-centric: the worker is the **only** owner of the device
  (the firmware serves one transaction at a time and refuses a second vendor
  request while a touch window is parked). A second request **waits** on the
  worker's FIFO queue; it is never refused by the firmware.
- Page surface: `getPublicKey`, `signEvent`, `listKeys`, `nip44.encrypt`,
  `nip44.decrypt` — the NIP-07 trio plus device NIP-44. Key management lives
  in the popup only.
- Consent: per-site grant popup with optional "remember this site"; the device
  touch is always required on top (firmware-enforced).
- The MAIN-world provider is injected as a `<script src>` tag (no
  `world: "MAIN"` manifest entry — the same-file-two-worlds content-script
  dedup bug kills `window.nostr` on Chrome 154; verified live 2026-10-11).
- MIT. The hardware client core is ported verbatim from OpenXrypt
  `feat/nostr` (MIT, © Edilson Osorio Jr) at HEAD `d431b00` — `ctaphid.js`,
  `seams.js`, `loudness.js`, `batch.js`, `window_nostr.js`, byte-identical
  except a small, declared allow-list of hardware-forced fixes (the real
  WebHID `sendReport(reportId, data)` signature and Chrome's DataView report
  data — both named by live hardware and recorded in the fidelity test). The ported test
  suite is the six nostr test files: **51 tests**. (The epic's "78-test
  suite" counts OpenXrypt's whole tree; the other 27 tests are the PGP
  stack, which decision D1 keeps out of scope.)

## Layout

```
src/core/       the verbatim port (ctaphid, seams, loudness, batch, window_nostr)
src/provider/   MAIN-world window.nostr (injected script tag)
src/content/    isolated-world bridge (stateless relay + injection)
src/worker/     the device owner: dispatch, serialization queue, permissions,
                prompt flow, consent gate, session persistence, error map
src/popup/      pairing, keys, generate/import/delete/label/export, sites
src/prompt/     the approval prompt window
src/manual/     the hardware ceremony (US-1709)
dist/           the committed bundle (rebuilt by CI; a stale dist fails the tree)
tests/          node --test suites + the CDP smoke gate (tests/smoke/) + the
                manual ceremony page (tests/manual/)
```

## Build & test

```
npm ci
npm test        # build + node --test (152+ tests) + the CDP smoke when Chrome is present
npm run check   # build + bundle-freshness diff + tests
```

Load the extension: `chrome://extensions` → Developer mode → **Load unpacked**
→ select the **`dist/` folder** (not the repo root — the root is source;
`src/manifest.json` is the build input and Chrome cannot load it).

## Hardware contract

The extension speaks the vendor protocol documented in the firmware tree:
`firmware/src/nostr_wire.rs` (commands `0x40`–`0x4A`, CBOR envelope
`[idx, arg]` → `{1: sw, 2?: data}`, D13 status vocabulary, 1,891-byte
argument cap), CTAPHID framing per `docs/ctap2-hid-framing.md`, on USB HID
interface 3 (usage page `0xFF00`, usage `0x01`). The protocol-fixture test
(`tests/protocol_fixture.test.js`, fixture transcribed from `nostr_wire.rs`
at `feat/nostr` `d15abe7`) pins those bytes so the two trees cannot drift
silently.

## Release

**Every release tag is gated by the hardware ceremony** (`US-1709`):
a human runs `tests/manual/ceremony.html` against a flashed board
(serve the repo root, e.g. `python3 -m http.server`):

1. INIT — capFlags `0x00`, version `0.1.0`
2. Generate key (touch)
3. `getPublicKey` from the live page path
4. `signEvent` (touch) — the signature verifies against nostr-tools
5. `nip44.encrypt`/`decrypt` round trip through the device (touch)
6. Delete key (touch) — the echoed npub must match

Steps are ordered: a failed step blocks the next, and a partial pass is not a
pass. The ceremony's JSON results are copied into the release notes (the
`fapico2` hardware-matrix convention) — the current record lives in
[docs/ceremony-results.md](docs/ceremony-results.md): **PASSED 2026-10-11**
on `feat/nostr` `a795d0d` (all six steps `9000`, signature nostr-tools-
verified, nip44 round trip byte-exact, delete npub-echo matched). CI additionally runs the CDP smoke
gate (US-1708) on real Chrome — `window.nostr` must install and reject
absence typed — a failure there is a release blocker too.
