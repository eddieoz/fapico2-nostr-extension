// US-1690 — the wire fixture: this repo's client constants, transcribed from
// the firmware's wire authority. Source of truth:
//   fapico2 feat/nostr, commit d15abe7, firmware/src/nostr_wire.rs
//   (NOSTR_CMD_*, SW_*, NOSTR_REQ_ARG_MAX) and firmware/src/ctap_hid.rs /
//   hid_serve.rs (the CTAPHID framing shapes).
// The fixture is data, not code: tests/protocol_fixture.test.js asserts the
// ported core against these values so the two trees cannot drift silently.
// If the firmware changes the wire, the change lands here first as an
// explicit, reviewed edit.
export const SOURCE_COMMIT = 'd15abe7';
// The fixture has been extended past d15abe7 twice: the PIN custody dialect
// (fapico2 feat/nostr-pin, through US-1702, nostr_wire.rs NOSTR_CMD
// 0x4B..0x4D and the SW_PIN_SESSION_REQUIRED / SW_PIN_LOCKED vocabulary),
// and the custody-ceremony bytes (US-1714/US-1716, NOSTR_CMD 0x4E and the
// SW_SEALED_UNAVAILABLE / SW_CEREMONY_NOT_NEEDED vocabulary) — each an
// explicit, reviewed edit per the rule below.

// firmware/src/nostr_wire.rs — NOSTR_CMD_* (u8).
export const NOSTR_CMD = {
  PING: 0x40,
  GET_PUBKEY: 0x41,
  SIGN: 0x42,
  NIP44_ENCRYPT: 0x43,
  NIP44_DECRYPT: 0x44,
  LIST_KEYS: 0x45,
  GENERATE_KEY: 0x46,
  IMPORT_KEY: 0x47,
  EXPORT_KEY: 0x48,
  DELETE_KEY: 0x49,
  SET_LABEL: 0x4a,
  // The PIN custody verbs (US-1691..1694, US-1702). SET_PIN's envelope idx
  // rides P1: 0 selects SET, 1 selects CHANGE. EXPORT_KEY is retired — the
  // firmware maps it to nothing and answers 0x6D00 in band (US-1699).
  VERIFY_PIN: 0x4b,
  SET_PIN: 0x4c,
  LOCK: 0x4d,
  // The custody ceremony (US-1714): the explicit migration verb the
  // extension's "Migrate now" dialog drives. The consent is the dialog,
  // not a touch — the applet is neither touch-gated nor session-gated.
  CEREMONY_START: 0x4e,
};

// firmware/src/nostr_wire.rs — the D13 §2.2.0 vocabulary as it crosses the
// transport (SW_WRONG_DATA 0x6A80, SW_STORE_FAULT 0x6F00, SW_TOUCH_REQUIRED
// 0x6985) plus the applet's answers the client must render: OK 0x9000,
// INS_NOT_SUPPORTED 0x6D00, and the file-not-found / not-allowed /
// wrong-condition family (0x6A82 file not found, 0x6A84 file full,
// 0x6A86 incorrect parameters, 0x6A88 referenced data not found, 0x6B00
// wrong P1/P2, 0x6A87 Lc inconsistent).
export const SW = {
  OK: 0x9000,
  WRONG_DATA: 0x6a80,
  FILE_NOT_FOUND: 0x6a82,
  FILE_FULL: 0x6a84,
  INCORRECT_P1P2: 0x6b00,
  LC_INCONSISTENT: 0x6a87,
  INCORRECT_PARAMS: 0x6a86,
  REFERENCED_DATA_NOT_FOUND: 0x6a88,
  TOUCH_REQUIRED: 0x6985,
  // Alias: OpenXrypt's verbatim core names 0x6985
  // CONDITIONS_NOT_SATISFIED (the ISO 7816-4 word's own name); the firmware
  // calls it SW_TOUCH_REQUIRED. Same byte, two names — the value is the pin.
  CONDITIONS_NOT_SATISFIED: 0x6985,
  INS_NOT_SUPPORTED: 0x6d00,
  STORE_FAULT: 0x6f00,
  // The PIN custody vocabulary (US-1691..1694). 0x6a82 is dual-homed — the
  // firmware reads it as file-not-found OR no-PIN-set, by context; 0x63c0
  // is the bottom of the 63CX range a wrong PIN answers with (63C1..63C3
  // are 0x63c0 | attempts_remaining, rendered by the error map, not named
  // constants).
  PIN_SESSION_REQUIRED: 0x6982,
  PIN_LOCKED: 0x63c0,
  // The custody-ceremony vocabulary (US-1714). 0x6F01 is the sealed board
  // whose custody store cannot open this boot (RAM-only until the recovery
  // ladder runs); 0x6F02 is the ceremony's "nothing to do". 0x6F00 during a
  // ceremony run is interrupted-retryable — a context mapping, not the
  // store-fault phrasing (US-1717).
  SEALED_UNAVAILABLE: 0x6f01,
  CEREMONY_NOT_NEEDED: 0x6f02,
};

// firmware/src/nostr_wire.rs — NOSTR_REQ_ARG_MAX (derived from
// fapico2_nostr::MAX_REQUEST_ARG; the §2.2.1 wire cap, US-1678).
export const NOSTR_REQ_ARG_MAX = 1891;

// The envelope shapes: request CBOR array(2) [idx, arg]; response
// map {1: sw, 2?: data}. Encoded as the head bytes the decoder must accept.
export const REQUEST_HEAD = 0x82; // array(2), always
export const RESPONSE_HEADS = [0xa1, 0xa2]; // map(1) / map(2)

// The vendor CTAPHID surface (firmware/src/ctap_hid.rs interface 3):
// usage page 0xFF00, usage 0x01, INIT reply 17 bytes with capFlags at
// byte 16 and the vendor version at bytes 13..15.
export const USAGE_PAGE = 0xff00;
export const USAGE_ID = 0x01;
export const INIT_REPLY_LEN = 17;
export const INIT_CAPFLAGS_OFFSET = 16;
export const INIT_VENDOR_VERSION_OFFSET = 13;

// The framing constants Chromium's writer uses (the byte-exact spec both
// trees follow): 64-byte reports, 57/59 payload split.
export const REPORT_SIZE = 64;
export const FIRST_PAYLOAD = 57;
export const CONT_PAYLOAD = 59;
