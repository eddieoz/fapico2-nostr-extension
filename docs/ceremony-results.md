# fapico2-nostr-extension — hardware ceremony record (US-1709)

The release gate (README §Release). Each entry is one full ceremony run:
the six ordered steps, their status words and timings, the operator, and
the board/firmware it ran against. A partial pass is not a pass — an
incomplete entry stays open at the top until a complete one supersedes it.

## OPEN — attempt 2026-10-11: blocked before step 1 (firmware mismatch)

**Board:** fapico2, USB `1050:0407` ("The BLOCO Community fapico2"),
serial path `1-1`, attached at 17:00 local.

**Probed (host-side, direct hidraw + sysfs):**

| Expected (feat/nostr, US-1657/1661) | Observed |
|---|---|
| 4 USB interfaces: CCID, FIDO HID, keyboard HID, **Nostr HID (usage 0xFF00:0x01)** | 3 interfaces: CCID (`1-1:1.0`, class 0x0b), FIDO HID (`1-1:1.1`), keyboard HID (`1-1:1.2`) — **no 0xFF00 collection on any fapico2 hidraw node** |
| Nostr-interface INIT reply: vendor version **0.1.0**, capFlags **0x00** | FIDO-interface INIT reply (raw CTAPHID over `/dev/hidraw1`): nonce echo ok, vendor version **5.4.0**, capFlags **0x05** |

The observed INIT bytes match `fapico2` **main**'s `init_reply(&nonce,
&channel, 5, 4, 0)` (`firmware/src/ctap_hid.rs:731`, management applet
`VERSION_MAJOR=5 VERSION_MINOR=4`): the board is running the **main-line
firmware 5.4.0**, not the `feat/nostr` build (`d15abe7`) whose separate
Nostr interface reports `NOSTR_VENDOR_VERSION (0x00, 0x01, 0x00)` with
`NOSTR_INIT_CAP_FLAGS = 0x00`.

**Ceremony result:** step 1 (INIT) cannot arm — the page reports the typed
refusal ("no Nostr interface (0xFF00:0x01)"), which is the correct,
loud behavior on this firmware. Zero steps passed; nothing was touched
and no key material was involved.

**Browser evidence (chrome-devtools, real Chrome):** the ceremony page
loads and renders from the repo root server; `navigator.hid.getDevices()`
finds no device carrying the `0xFF00:0x01` collection; the host hidraw
descriptors confirm it.

**To close this entry:**

1. Flash the board with the `fapico-nostr` (`feat/nostr`, `d15abe7`) build —
   the `fapico2` tree's flash flow (build-signed + the post-flash park).
   This overwrites the running 5.4.0 main-line build; it is the operator's
   call, not an automatic one.
2. Serve the repo root: `python3 -m http.server 8765 --bind 127.0.0.1`
3. Open `http://127.0.0.1:8765/tests/manual/ceremony.html`, click
   **Select the Nostr interface**, pick the board in the chooser.
4. Run the six ordered steps, giving each touch-gated step its physical
   press (generate → getPublicKey → signEvent → nip44 round trip →
   delete). The page blocks at the first failure.
5. Paste the JSON results block into the release notes and mark this
   entry superseded.
