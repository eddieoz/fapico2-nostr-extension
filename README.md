# fapico2-nostr-extension

A Nostr-only, hardware-first browser extension: every `window.nostr` key
operation is performed by a **fapico2 board** (RP2350 running the
[`fapico2`](https://github.com/eddieoz/fapico2) firmware's Nostr applet) over
WebHID. Keys never live in the browser; every signature, NIP-44
encrypt/decrypt and key-set change is consented by a **physical touch** on the
device (firmware-enforced — the extension cannot bypass it).

- **Status:** implemented and hardware-verified. The release ceremony
  (US-1709) PASSED 2026-10-11 and the full US-1734 UX-journey gate PASSED
  2026-10-13 on hardware — see
  [docs/ceremony-results.md](docs/ceremony-results.md).
- **License:** MIT ([LICENSE](LICENSE)).

## Contents

- [Key features](#key-features)
- [Tech stack](#tech-stack)
- [Prerequisites](#prerequisites)
- [Getting started](#getting-started)
- [Architecture](#architecture)
- [Scripts](#scripts)
- [Testing](#testing)
- [Hardware contract](#hardware-contract)
- [Release gate](#release-gate)
- [Troubleshooting and known browser quirks](#troubleshooting-and-known-browser-quirks)
- [Repository docs map](#repository-docs-map)

## Key features

- **NIP-07 on hardware** — `getPublicKey`, `signEvent`, `nip44.encrypt`,
  `nip44.decrypt` (plus `listKeys`) implemented by the board, not the
  browser. Key management (generate, import, label, export, delete, active
  slot) lives in the popup only.
- **Per-site consent** — a grant popup per site and method, with optional
  "remember this site"; the device touch is always required on top, and the
  Sites screen lists and revokes grants.
- **One device owner** — the MV3 service worker exclusively owns the WebHID
  handle; concurrent requests serialize through its FIFO queue (the firmware
  serves one transaction at a time).
- **Typed errors everywhere** — failures cross every boundary (worker →
  prompt window → page) as human-readable typed sentences, never raw CTAP
  status words.
- **Committed bundle** — `dist/` is committed and CI fails the tree if a
  rebuild differs, so the loadable extension is never stale.

## Tech stack

- **Language:** JavaScript (ES modules), no framework
- **Extension platform:** Chrome MV3 (`minimum_chrome_version` 116)
- **Bundler:** esbuild 0.28 (7 IIFE bundles into `dist/`)
- **Package manager:** pnpm 10 (`pnpm-workspace.yaml` allows esbuild's
  postinstall)
- **Tests:** `node --test` (350 tests), a CDP smoke gate on real Chrome, and
  a manual hardware-ceremony page
- **Crypto libraries (bundled):** `@noble/hashes`, `@noble/curves`,
  `@scure/base`; `nostr-tools` for independent verification in tests and the
  ceremony
- **Device transport:** WebHID (permissions: `storage`, `hid` — nothing else)

## Prerequisites

- Node.js 20+
- pnpm 10 (`corepack enable` or `npm i -g pnpm`)
- Chrome/Chromium 116+ (to load and run the extension; the CDP smoke gate
  additionally needs a `CHROME_PATH`)
- A flashed fapico2 board for any real device operation. Without a board the
  UI screens still run and the test suite passes; device operations
  legitimately fail with a typed "no device" sentence.

## Getting started

### 1. Clone and install

```bash
git clone https://github.com/eddieoz/fapico2-nostr-extension.git
cd fapico2-nostr-extension
pnpm install --frozen-lockfile
```

### 2. Build

```bash
pnpm build        # 7 esbuild bundles + manifest, pages, styles, icons → dist/
```

### 3. Load the extension

`chrome://extensions` → Developer mode → **Load unpacked** → select the
**`dist/` folder**. Not the repo root — the root is source;
`src/manifest.json` is the build input and Chrome cannot load it.

### 4. Pair the board (first connect)

Click the toolbar icon → **Connect**. A small connect window opens (the
device chooser cannot anchor to the action popup — it closes on blur and
cancels the request); click Connect and pick the **fapico2 vendor interface**
in the browser's device picker.

> Chromium's FIDO-exclusion rule hides the board's security-key (CTAPHID)
> interface from WebHID choosers. The board exposes the vendor interface
> (usage page `0xFF00`) as a separate entry — that is the one to pick, and
> the connect window says so.

After pairing, the popup walks you to **Generate** your first key; the board
requires a physical touch for generate, sign, NIP-44 and delete operations.

## Architecture

### Directory structure

```
src/
├── core/        the hardware client core, ported verbatim from OpenXrypt
│                feat/nostr @ d431b00 (ctaphid, seams, loudness, batch,
│                window_nostr) with a small declared allow-list of
│                hardware-forced fixes — pinned by the cross-check tests
├── provider/    MAIN-world window.nostr (injected <script src> tag)
├── content/     isolated-world bridge — stateless relay, no device access
├── worker/      the device owner: dispatch, serialization queue, permissions,
│                prompt flow, consent gate, session persistence, error map
├── popup/       keys screen, connect window, pairing, sites/grants, tokens
├── prompt/      the per-request approval prompt window
├── manual/      the hardware ceremony page's bundle
├── manifest.json
dist/            the committed bundle (rebuilt by build.mjs; never hand-edited)
tests/           node --test suites, CDP smoke gate, manual tooling
docs/            design, ceremony records, a11y walk, visual records
```

### Request lifecycle (a `signEvent` from a web page)

1. The page calls `window.nostr.signEvent(event)`.
2. The MAIN-world provider (injected `<script src>` tag) posts the request to
   the isolated-world bridge over `window.postMessage`.
3. The bridge relays it to the service worker over a named port.
4. The worker checks the site's grant (prompting via the prompt window when
   needed — the touch happens here too, firmware-side) and serializes the
   device operation through its FIFO queue.
5. The worker drives the board over CTAPHID/WebHID and returns the
   signature through the same chain.

```
page ─ window.nostr ─ provider (MAIN) ─ bridge (isolated) ─ worker ─ WebHID ─ board
                                                  ↕ grant prompt window ↕ touch
```

### Invariants worth knowing

- **The worker is the only device owner.** No other surface constructs a
  transport (enforced by a test). A second request waits on the FIFO; the
  firmware is never asked to serve two transactions at once.
- **The provider is injected as a `<script src>` tag**, not
  `world: "MAIN"` — the same-file-two-worlds content-script dedup bug kills
  `window.nostr` on Chrome 154 (verified live 2026-10-11).
- **`requestId` is one namespace**: dispatch composites `port.name` +
  `frame.id`, so two tabs' concurrent prompts never collide.
- **The hardware core is a pinned port.** `src/core/` is byte-identical to
  OpenXrypt `feat/nostr` `d431b00` except a declared allow-list of two
  hardware-forced fixes (the real WebHID `sendReport(reportId, data)`
  signature; Chrome's DataView report data). The cross-check test suite runs
  OpenXrypt's own nostr tests (51) against this tree, and
  `tests/protocol_fixture.test.js` pins the wire bytes transcribed from the
  firmware's `nostr_wire.rs` (`feat/nostr` `d15abe7`) so the two trees cannot
  drift silently.
- **Extension pages heartbeat the worker** so the MV3 worker never idles out
  mid-flow, and a silently-dead port is abandoned by staleness guard before
  it can black-hole a call (MV3 worker restarts are a designed-for event,
  not an error).

## Scripts

| Command            | Description                                                            |
| ------------------ | ---------------------------------------------------------------------- |
| `pnpm build`       | Bundle `src/` into `dist/` (esbuild + verbatim copies)                 |
| `pnpm test`        | Build, then the full `node --test` suite (350 tests)                   |
| `pnpm run check`   | Build + bundle-freshness diff (`git diff --exit-code -- dist/`) + tests |
| `pnpm run test:smoke` | CDP smoke gate on real Chrome (`CHROME_PATH` required)              |
| `node tests/manual/visual-pass.mjs` | Screenshot journey through the dist pages (manual; writes `docs/visual/`) |

## Testing

```bash
pnpm test          # everything machine-testable; no board required
pnpm run test:smoke  # needs Chrome: window.nostr installs and rejects absence typed
```

- `tests/*.test.js` — the `node --test` suites (unit + integration over a
  mock device; `tests/mock_device.js` is the fixture).
- `tests/fixtures/` — **pinned bytes, do not edit**: the OpenXrypt
  `d431b00` tree used by the cross-check suites and the `nostr_wire.rs`
  protocol fixture.
- `tests/smoke/` — the CDP smoke gate against real Chrome.
- `tests/manual/` — `ceremony.html` (the hardware release gate) and
  `visual-pass.mjs` (screenshot records). Not part of `pnpm test`.

## Hardware contract

The extension speaks the vendor protocol documented in the firmware tree:
`firmware/src/nostr_wire.rs` (commands `0x40`–`0x4A`, CBOR envelope
`[idx, arg]` → `{1: sw, 2?: data}`, D13 status vocabulary, 1,891-byte
argument cap), CTAPHID framing per the firmware's
`docs/ctap2-hid-framing.md`, on USB HID interface 3 (usage page `0xFF00`,
usage `0x01`). The wire bytes are pinned by
`tests/protocol_fixture.test.js`.

## Release gate

**Every release tag is gated by the hardware ceremony** (US-1709): a human
runs `tests/manual/ceremony.html` against a flashed board (serve the repo
root, e.g. `python3 -m http.server`):

1. INIT — capFlags `0x00`, version `0.1.0`
2. Generate key (touch)
3. `getPublicKey` from the live page path
4. `signEvent` (touch) — the signature verifies against nostr-tools
5. `nip44.encrypt`/`decrypt` round trip through the device (touch)
6. Delete key (touch) — the echoed npub must match

Steps are ordered: a failed step blocks the next, and a partial pass is not
a pass. The ceremony's JSON results are copied into the release notes; the
records live in [docs/ceremony-results.md](docs/ceremony-results.md) — the
latest: **PASSED 2026-10-11** (firmware `fapico-nostr` `feat/nostr` at
`a795d0d`; signature nostr-tools-verified, NIP-44 round trip byte-exact,
delete npub-echo matched) and the **US-1734 UX-journey gate PASSED
2026-10-13** (the full journey on hardware). CI additionally runs the CDP
smoke gate on real Chrome — a failure there is a release blocker too.

## Troubleshooting and known browser quirks

- **"No device selected" with no chooser appeared** — a chooser cannot
  anchor to the action popup (it closes on blur). The extension already
  routes choosers through the dedicated connect window; if you see this from
  your own tooling, run the chooser in a real extension window, never the
  action popup or the service worker.
- **The board appears twice in the picker / security-key entry missing** —
  Chromium hides FIDO usage-page interfaces from WebHID choosers; pick the
  vendor (`0xFF00`) entry.
- **Prompt shows a Chrome packaging warning about `hid`** — "'hid' is only
  allowed for packaged apps" is cosmetic; the permission works.
- **Worker went silent mid-flow** — MV3 workers idle out; the extension
  heartbeats and reconnects by staleness guard. If you are extending the
  code, keep every surface going through `src/shared/port-client.js` rather
  than raw ports.
- **WebHID grants survive extension removal** and the HID settings page does
  not list extension grants — a Chromium quirk; fully uninstall and reload
  to reset grants.
- **`HIDDevice.forget()` is not used** for revocation — it revokes the
  vendor-interface grant, which cannot be re-granted through the UI (the
  chooser hides the interface). The US-1743 Disconnect toggle was reverted
  for exactly this reason.

## Repository docs map

| Path                          | Contents                                                  |
| ----------------------------- | --------------------------------------------------------- |
| [docs/design.md](docs/design.md) | The approved design (review record)                    |
| [docs/ceremony-results.md](docs/ceremony-results.md) | Hardware ceremony/journey records |
| [docs/a11y-keyboard-walk.md](docs/a11y-keyboard-walk.md) | The keyboard-walk a11y record |
| `docs/visual/`                | US-1740 before/after screenshot record (generated by `tests/manual/visual-pass.mjs`) |
| `docs/tasks/`, `docs/superpowers/` | Private working documents (gitignored by convention) |
| [AGENTS.md](AGENTS.md)        | Working conventions for AI coding agents                  |
