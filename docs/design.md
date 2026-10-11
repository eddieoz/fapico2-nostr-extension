# Design: fapico2-nostr-extension

**Status:** approved (2026-10-11, brainstorming session with eddieoz)
**Source evidence:** the systematic review of OpenXrypt `feat/nostr` and the
`fapico2` `feat/nostr` firmware (2026-10-11) — hardware acceptance probe of the
Nostr vendor interface passed on the board; Chrome 154 runtime testing found
the same-file-two-worlds content-script bug that kills `window.nostr`.

## 1. Decisions (locked in brainstorming)

| # | Decision | Choice |
|---|---|---|
| D1 | Product shape | **Nostr-only, hardware-first.** OpenXrypt's PGP x.com/WhatsApp stack stays out. |
| D2 | Codebase | **New repo** `fapico2-nostr-extension` (sibling in the `pico/` workspace), MIT, not a derivative of any GPL extension (flamingo/nos2x are GPL-3; aka-extension is unlicensed). |
| D3 | Core reuse | The OpenXrypt nostr core is **ported verbatim**: `ctaphid.js` (417 L), `seams.js` (302 L), `loudness.js` (112 L), `window_nostr.js` (148 L), `batch.js` (175 L, retained for batched decrypt), `content_entry.js` as reference, plus the 78-test suite and `mock_device.js`. |
| D4 | Consent model | **Per-site grant popup** (nos2x-style) with **optional "remember this site"**; unchecked = this-time-only. The device touch is *always* required on top (firmware-enforced, non-negotiable). |
| D5 | Page surface (v1) | `getPublicKey`, `signEvent`, `listKeys` + `nip44.encrypt` / `nip44.decrypt` (device commands `0x43`/`0x44`, touch-gated). Key management lives in the popup only, never on `window.nostr`. |
| D6 | Device ownership | The **service worker owns the device exclusively** — one transport, one transaction at a time. Content scripts are stateless relays. This matches the firmware contract: one transaction per interface; a second vendor request while a touch window is parked is refused `6985`, never queued (red-team F6). |
| D7 | MAIN-world injection | **Script-tag injection** from the isolated world + `web_accessible_resources` (the Flamingo pattern). No `world: "MAIN"` manifest entry — this structurally avoids the Chrome same-file-two-worlds dedup bug verified live on Chrome 154. |
| D8 | MV3 lifetime | Port-based messaging (`chrome.runtime.connect`), pending-request map persisted to `chrome.storage.session`, prompt-window close = explicit reject. |

## 2. Architecture

```
page (MAIN world)          content script (isolated)      service worker           extension pages
window.nostr  ──postMessage──▶ bridge  ──chrome.runtime──▶  SW: device owner   ◀──── popup / prompt window
                            relay, stateless              ports + pending map        (UI only)
```

Four entry points:

1. **Provider** (`src/provider/nostr-provider.js`) — MAIN world, injected as a
   `<script src>` tag. Builds `window.nostr` with a per-request id map over
   `window.postMessage`; attaches `host: location.host`; never clobbers an
   existing provider. No promise timeout — the device may take seconds.
2. **Bridge** (`src/content/bridge.js`) — isolated world, declared content
   script on `<all_urls>`. Stateless relay: page postMessage ⇄
   `chrome.runtime.connect` Port. Enforces the page-allowed method allow-list.
3. **Service worker** (`src/worker/`) — the device owner. Transport
   (`CtapVendorTransport`), transaction serialization (a FIFO that waits, so
   concurrent tabs never hit the firmware's refuse-while-parked path),
   permission checks, prompt-window orchestration, `storage.session`
   persistence of pending requests and session-only grants.
4. **UI** — popup (`connect/pair`, key management screens, sites/revocations)
   and the approval prompt window. Touch-gated operations show
   "touch your device" with the keepalive state flowing back.

## 3. Manifest

- MV3; `permissions: ["storage"]`; `host_permissions` none beyond content
  script matches (`<all_urls>`, isolated world only, `document_start`).
- `web_accessible_resources`: exactly the provider chunk.
- No background page; the MV3 service worker is registered normally.

## 4. Permission model

`chrome.storage.local`: `{ [host]: { grantedAt, methods: { getPublicKey?,
signEvent?, listKeys?, nip44? } } }`, written only by the prompt window via the
worker. Unchecked "remember" = session-only grant held in the worker's memory.
The popup's Sites screen lists and revokes. `getPublicKey` prompts once per
site (identity disclosure is a consent event).

## 5. Key management (popup only)

LIST_KEYS (`0x45`), GENERATE_KEY (`0x46`), IMPORT_KEY (`0x47`, nsec/hex
decode), DELETE_KEY (`0x49`), SET_LABEL (`0x4A`) — every mutating op
touch-gated on device; delete/export use loud confirms (export returns the
private scalar — explicit reveal only). Parse shapes per
`apps/nostr/src/lib.rs` (LIST_KEYS: `n ‖ idx ‖ flags ‖ npub ‖ len ‖ label`).

## 6. Error model

Inherited from the loudness/seams design: typed `DeviceAbsentError`,
`SwError` (D13 vocabulary), `SignerError`. Mappings: `6985` after the 15 s
window → "touch timed out"; second-request refusal → "device busy — another
operation is waiting"; no-gesture `SecurityError` → typed absent error at the
provider. Raw errors never leak to the page. **No silent software fallback** —
the software signer exists as a test double only.

## 7. Toolchain & CI

esbuild (four entries: provider, bridge, worker, popup), `node --test` (the
ported suite runs unmodified), GitHub Actions gate: bundle-freshness diff +
tests + the protocol-fixture test. A CDP smoke test loads the built extension
in real Chrome (`Extensions.loadUnpacked` + `--enable-unsafe-extension-debugging`)
and asserts `window.nostr` exists and answers — the test that would have caught
the OpenXrypt P0.

## 8. Hardware protocol contract (pinned)

Usage page `0xFF00` usage `0x01`, interface 3; CTAPHID framing (64-byte
reports, 57/59 split, INIT on `FFFFFFFF`, 17-byte reply with capFlags at byte
16); vendor commands `0x40`–`0x4A`; request CBOR `[idx(u8), arg]`, response
`{1: sw, 2?: data}`; SW vocabulary `9000/6A80/6A82/6A84/6A86/6A88/6985/6B00/
6A87/6F00/6D00`; request arg cap 1891 bytes; keepalive `0x3B`, CANCEL `0x11`.
A fixture test pins these against `fapico2 feat/nostr`'s `nostr_wire.rs` so the
two trees cannot drift silently.

## 9. Effort

MVP (core port + worker + provider + per-site grant + key screens): ~7–9 days.
Full (nip44 prompts, sites screen, CDP smoke in CI, polish): ~2–3 weeks.
