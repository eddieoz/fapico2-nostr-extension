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
