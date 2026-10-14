# AGENTS.md — working conventions for AI coding agents

fapico2-nostr-extension is a Chrome MV3 extension whose `window.nostr`
(NIP-07 + device NIP-44) is implemented by a fapico2 hardware board over
WebHID. Keys never live in the browser; every device operation is consented
by a physical touch that the firmware enforces. [README.md](README.md) is
the full reference; this file is the operating manual.

## Commands

```bash
pnpm install --frozen-lockfile   # pnpm 10 — the only package manager here
pnpm build                       # bundle src/ → dist/
pnpm test                        # build + the full node --test suite
pnpm run check                   # build + dist-freshness diff + tests (the gate)
pnpm run test:smoke              # CDP smoke gate; needs CHROME_PATH
```

Run `pnpm run check` before declaring any change done. It is what CI runs.

## Non-negotiables

1. **`dist/` is committed and must be rebuilt with every `src/` change.**
   `git diff --exit-code -- dist/` fails the tree when the bundle is stale.
   Never hand-edit files under `dist/` — change `src/` and `pnpm build`.
2. **pnpm only.** `pnpm-lock.yaml` is frozen in CI. Never add
   `package-lock.json` or `yarn.lock`. `pnpm-workspace.yaml` holds the
   esbuild postinstall allow-list — do not remove it.
3. **`src/core/` is a pinned port** of OpenXrypt `feat/nostr` `d431b00`
   (MIT, © Edilson Osorio Jr). Changes to it are limited to the declared
   allow-list of hardware-forced fixes, and the cross-check tests
   (`tests/fixtures/openxrypt-feat-nostr-d431b00/`,
   `tests/cross_check.test.js`) must stay green.
4. **`tests/fixtures/` pins wire bytes** transcribed from the firmware's
   `nostr_wire.rs` (`d15abe7`). Editing a fixture to make a test pass is
   never a fix — the fixture is the contract.
5. **Private docs stay private.** `docs/tasks/`, `docs/superpowers/`,
   `.superpowers/`, `.zcode/` are gitignored working documents (epics,
   stories, agent session state). Never commit them or their contents into
   other files.
6. **Consent is never bypassable in the extension.** The device touch is
   firmware-enforced; extension-side grant checks, the prompt flow, and the
   serialization queue are load-bearing security and UX structure. Any
   change that lets a request reach the device without its grant path is
   wrong, even if tests pass.

## Architecture map

| Path              | Role                                                             |
| ----------------- | ---------------------------------------------------------------- |
| `src/core/`       | Hardware client core (CTAPHID, seams, batching) — pinned port    |
| `src/worker/`     | The device owner: dispatch, FIFO queue, grants, prompt flow, session, error map |
| `src/provider/`   | MAIN-world `window.nostr`, injected as a `<script src>` tag      |
| `src/content/`    | Isolated-world bridge — stateless relay, no device access        |
| `src/popup/`      | Keys screen, connect window, pairing, sites/grants               |
| `src/prompt/`     | Per-request approval prompt window                               |
| `src/manual/`     | The hardware ceremony page's bundle                              |
| `src/shared/`     | `port-client.js` (the only sanctioned port layer), protocol, method words |

Invariants the tests enforce — do not weaken them:

- **Only `src/worker/device.js` constructs a transport.** Every surface
  (popup, connect, prompt pages) talks to the worker through
  `src/shared/port-client.js`; no page ever touches WebHID.
- **MV3 worker restarts are normal.** Pages heartbeat the worker and
  reconnect under staleness guard; port death mid-flow must heal, not
  black-hole. Any new page surface inherits this from `port-client.js`.
- **`requestId` is one namespace**: dispatch composites `port.name` +
  `frame.id`. Never route by bare `frame.id`.
- **Errors cross boundaries as typed sentences** (`src/worker/error-map.js`,
  `src/worker/errors.js`) — raw CTAP status words must not leak to any UI.

## Tests

- `node --test`, colocated in `tests/*.test.js`; the mock device lives in
  `tests/mock_device.js`. Follow the existing naming: one suite per
  behavior, subtests titled with their US-#### story and the sentence they
  prove.
- UI changes: keep `tests/design_tokens.test.js` green (tokens live in
  `src/popup/tokens.css`), respect the a11y floor (11px type, contrast,
  `:focus-visible` amber ring, status regions).
- Board-dependent behavior (touch windows, firmware timeouts) cannot be
  machine-tested. If you change device interaction, say so in the PR — the
  manual ceremony (`tests/manual/ceremony.html`) is the release gate, and
  `tests/manual/visual-pass.mjs` records UI screenshots into `docs/visual/`.

## Commits and PRs

- Conventional prefixes (`feat`, `fix`, `test`, `docs`, `build`, `chore`,
  `revert`) with the story reference, e.g.
  `fix(shared): staleness-guarded reconnect — a silent port is abandoned before it black-holes a call (US-1744 board-run finding)`.
- One behavior per commit; a revert states the reason (see the US-1746
  revert for the house style: what bricked, why it can never work).
- CI must be green (`pnpm run check` + smoke) and the ceremony record
  updated in `docs/ceremony-results.md` for any hardware-visible change.

## Known Chromium quirks (designed around, do not "simplify" away)

- A device chooser cannot anchor to the action popup (closes on blur,
  cancels the request) — choosers run in the dedicated connect window.
- Chromium's FIDO-exclusion rule hides CTAPHID interfaces from WebHID
  choosers — the board's vendor interface (`0xFF00`) is the one to pick.
- `port.onDisconnect` is not reliably delivered on worker idle death —
  hence the staleness guard.
- `world: "MAIN"` manifests break under the same-file-two-worlds dedup bug
  (Chrome 154, verified 2026-10-11) — the provider stays a `<script src>`
  injection.
- `HIDDevice.forget()` bricks re-pairing for this device — never reintroduce
  it (the reverted US-1743 toggle is the reference).
