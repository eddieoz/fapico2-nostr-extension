# fapico2-nostr-extension — hardware ceremony record (US-1709)

The release gate (README §Release). Each entry is one full ceremony run:
the six ordered steps, their status words and timings, the operator, and
the board/firmware it ran against. A partial pass is not a pass — an
incomplete entry stays open at the top until a complete one supersedes it.

## OPEN — US-1734 UX-journey gate: all steps exercised on hardware; one sub-step re-verify pending (US-1741)

**Board:** fapico2, USB `FA20:0002` ("The BLOCO Community fapico2"),
operator eddieoz (every chooser pick, approval, and device touch).
**Extension:** `feat/nostr` dist, from `161bf89` + the typed-sentence fix
`d21b86f` loaded mid-run. Chrome 154, real display, driven via CDP
(trusted input events; the operator performed every consent decision).
The operator also ran the product on the real Nostr site **ditto.pub**.

**Journey steps — all PASS on hardware:**

- **delete key** — the operator's first step on the live board: recognition
  copy (name + truncated npub + slot), checkbox gate, touch.
- **generate key** — two keys generated (slots 0 and 1), touch each time;
  slot picker and success notices as designed.
- **site sign (ditto.pub)** — real NIP-07 login (getPublicKey) and posts
  (sign_event) through the real consent path: one sentence + `SIGN_EVENT`
  chip + identity row naming the active slot, approve → amber touch state →
  touch → signed beat. A kind-22242 event rendered "signs a authentication
  of a client" (the kind words map works). The prompt fits its 420×320
  window (US-1740's rhythm fix, verified on the real surface).
- **active-key switch** — radio slot 0 → 1, instant (touch-free), the strip
  updated and the typed "sites that cached your other npub" notice showed;
  restored to slot 0 at the end of the run.
- **touch-timeout (6985)** — approve → withhold the touch → the firmware's
  ~15 s timeout surfaced **in the prompt window** (D-UX6's headline fix
  works on hardware). First run exposed a real bug: the window showed the
  raw word "SIGN refused with 0x6985" instead of the typed sentence —
  `describeSw` was only applied in the popup's display path. **Fixed during
  the run** (`d21b86f`, red-first: the sentence now crosses both the settle
  push and the port boundary); the re-run showed **"touch timed out — the
  device asked for a touch and none came"** (operator-confirmed).
- **sites revoke / revoke-all** — single revoke: one click, "revoked
  ditto.pub" typed ok notice, list refreshed. Revoked grants re-prompt ✓.
  Revoke-all: two-step armed confirm on the real toolbar popup ("Confirm
  revoke all"; an expired arm disarms silently) → "revoked all grants".

**Findings (the run's purpose):**

1. **FIXED during the run** — the raw status word crossed the settle push
   and the port boundary (`d21b86f`, this branch).
2. **US-1741 (queued)** — extension pages don't heal their port after an
   MV3 worker restart (~30 s idle): the bridge reconnects lazily, the
   popup/connect pages don't. Real trigger: the operator sitting at the
   device chooser past the idle window → `pair_device` threw Chrome's
   internal "Attempting to use a disconnected port object" into the page
   (the typed-transport-error half of US-1741's scope).
3. **UX note (recorded, unscheduled)** — when the connect tab auto-closes
   (returning board), focus lands on the session's blank tab; a
   disconnect/re-pair affordance also doesn't exist. Both are design
   conversations, not riders.

**Sub-step pending re-verify:** the **first-run handoff line** ("connected —
open the fapico2 toolbar icon to create your first key", zero-key board
stays open) was not observed live — the live connect ran into finding 2
(port idle during the chooser) and completed only after a page refresh,
which takes the returning-board path. The handoff is machine-tested
(`tests/connect_page.test.js`, `tests/popup_connect_window.test.js`);
re-verify on hardware after US-1741 lands, then this entry supersedes to a
full PASS.

**Install note:** loading the unpacked dist shows a Chrome warning —
"'hid' is only allowed for packaged apps, but this is a extension." — the
permission works; cosmetic, Chrome's packaging policy text.

## PASSED — 2026-10-11, fapico-nostr `feat/nostr` (post-fix build)

**Board:** fapico2, USB `FA20:0002` ("The BLOCO Community fapico2"),
serial `60DA2F528AA9CE05`, RP2350.

**Firmware:** `fapico-nostr` `feat/nostr` at `a795d0d` — the OTP-read fixes
(`8e34ed4` retry boot OTP reads within a 20 s budget; `fb2ae41` remove the
runtime sw_lock write that broke page-0 OTP reads) merged from main after
the 18:52 flash of the pre-fix build parked dark (the hang the extension
did not cause; recorded below). UF2 built 20:46 from the clean tree.

**Pre-flight:** host-side raw CTAPHID INIT on the Nostr interface answered
version 0.1.0 / capFlags 0x00 before the ceremony; the interface enumerates
as usage page `0xFF00`, usage `0x01` as the contract requires.

**Operator:** eddieoz (device touches at each gated step); the run was
driven through the ceremony page in real Chrome via chrome-devtools
(chooser grant + five touches: generate, sign, nip44 encrypt, nip44
decrypt, delete).

**Result — all six ordered steps PASS, ceremony COMPLETE:**

```json
[
  {
    "step": "init",
    "ok": true,
    "sw": 36864,
    "detail": { "cid": "00000006", "version": "0.1.0", "capFlags": 0 },
    "ms": 65
  },
  {
    "step": "generate",
    "ok": true,
    "sw": 36864,
    "npub": "0addad3acd0ea076ba98f7f778cf7c875363fab9b5f98cce7f44a2a02c47fb30",
    "ms": 2848
  },
  {
    "step": "pubkey",
    "ok": true,
    "sw": 36864,
    "npub": "0addad3acd0ea076ba98f7f778cf7c875363fab9b5f98cce7f44a2a02c47fb30",
    "ms": 23
  },
  {
    "step": "sign",
    "ok": true,
    "sw": 36864,
    "id": "0e5c90b855f4cc26a960d89822e671914cedae460fcfa5f2420898971bf9718b",
    "ms": 1154
  },
  {
    "step": "nip44",
    "ok": true,
    "sw": 36864,
    "detail": "round trip ok (19 bytes)",
    "ms": 7739
  },
  {
    "step": "delete",
    "ok": true,
    "sw": 36864,
    "npub": "0addad3acd0ea076ba98f7f778cf7c875363fab9b5f98cce7f44a2a02c47fb30",
    "ms": 3110
  }
]
```

Every step answered `9000` (0x36864); `sign` was verified against
nostr-tools (`verifyEvent` + `schnorr.verify` against the device key) inside
the step; `nip44` round-tripped a 19-byte plaintext through the device
byte-exact; `delete`'s echoed npub matched the slot's npub. The generated
key was destroyed by the final step — nothing persists on the board.

**What the hardware run caught (all fixed, all recorded in git):**

1. `sendReport`'s real WebHID signature — the reportId is the **first**
   argument and the dictionary form OpenXrypt shipped does not exist
   (`42ca13d`, `2ccb65a`). The ported test double accepted the dictionary,
   so only hardware could name it.
2. `HIDInputReportEvent.data` is a **DataView** — the report pump's byte
   indexing saw undefined and discarded every report (`bcee1d9`).
3. The ceremony's raw INIT raced `device.open()`; the init step now rides
   the transport's own INIT via an oninputreport tap (`c8f199c`), and a
   reused grant can arrive wedged until a close/reopen (`bf831d1`).

---

## SUPERSEDED — attempt 2026-10-11 (18:52): blocked before step 1 (firmware mismatch)

The board then ran `fapico2` **main** 5.4.0 (INIT 5.4.0 / capFlags 0x05,
no `0xFF00` HID interface) — not the nostr build. Probed host-side
(hidraw + sysfs) and via chrome-devtools; the ceremony refused typed at
arm time, which is the correct loud behavior. Superseded by the PASSED
entry above after the feat/nostr flash; the original probe record follows.

<details>
<summary>Original probe record (18:52 attempt)</summary>

**Board:** fapico2, USB `1050:0407`, serial path `1-1`, attached 17:00.

| Expected (feat/nostr, US-1657/1661) | Observed |
|---|---|
| 4 USB interfaces: CCID, FIDO HID, keyboard HID, **Nostr HID (usage 0xFF00:0x01)** | 3 interfaces: CCID (`1-1:1.0`, class 0x0b), FIDO HID (`1-1:1.1`), keyboard HID (`1-1:1.2`) — **no 0xFF00 collection on any fapico2 hidraw node** |
| Nostr-interface INIT reply: vendor version **0.1.0**, capFlags **0x00** | FIDO-interface INIT reply (raw CTAPHID over `/dev/hidraw1`): nonce echo ok, vendor version **5.4.0**, capFlags **0x05** |

The observed INIT bytes matched `fapico2` main's `init_reply(&nonce,
&channel, 5, 4, 0)` (`firmware/src/ctap_hid.rs:731`).

**Ceremony result:** step 1 could not arm — the page reported the typed
refusal ("no Nostr interface (0xFF00:0x01)"). Zero steps passed; no key
material was involved.

</details>
