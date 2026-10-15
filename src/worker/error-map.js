// US-1707 — the SW → human-sentence mapping table: the single source of
// truth covering every status word in the D13 vocabulary the firmware can
// emit (fixture: tests/fixtures/nostr_wire_d15abe7.js). Every failure the
// page can see has a name and a next step; an unknown SW is still typed —
// `device-error` with the hex code in the sentence.

export const SW_ERROR_MAP = {
  0x9000: { code: 'OK', message: 'ok' },
  0x6a80: { code: 'SW_WRONG_DATA', message: 'the device refused the data — it could not read the request' },
  0x6a82: {
    code: 'SW_FILE_NOT_FOUND',
    message: 'that identity is not on the device — or, on a PIN verb, there is no PIN set yet',
  },
  0x6a84: { code: 'SW_FILE_FULL', message: 'that slot is occupied — delete it first' },
  0x6a86: { code: 'SW_INCORRECT_PARAMS', message: 'the device refused the parameters' },
  0x6a87: { code: 'SW_LC_INCONSISTENT', message: 'the device refused the command length' },
  0x6a88: { code: 'SW_REFERENCED_DATA_NOT_FOUND', message: 'nothing there to operate on' },
  0x6b00: { code: 'SW_INCORRECT_P1P2', message: 'the device refused the command parameters' },
  // The touch word: the consent window closed without a press (15 s), or a
  // second vendor request arrived while a window was parked (the queue
  // exists so the client never provokes that one).
  0x6985: { code: 'SW_TOUCH_REQUIRED', message: 'touch timed out — the device asked for a touch and none came' },
  0x6d00: { code: 'SW_INS_NOT_SUPPORTED', message: 'the device does not serve that command' },
  0x6f00: { code: 'SW_STORE_FAULT', message: 'the device could not complete the operation — its store faulted' },
  // The PIN custody rows (US-1705). 63C1..63C3 are the wrong-PIN answers
  // — the low byte IS the attempts remaining — and 63C0 is the same
  // range's floor: the lockout, whose only recovery is management RESET.
  0x63c3: { code: 'SW_PIN_RETRIES', message: 'wrong PIN — 3 attempts left', attempts: 3 },
  0x63c2: { code: 'SW_PIN_RETRIES', message: 'wrong PIN — 2 attempts left', attempts: 2 },
  0x63c1: { code: 'SW_PIN_RETRIES', message: 'wrong PIN — 1 attempt left', attempts: 1 },
  0x63c0: {
    code: 'SW_PIN_LOCKED',
    message: 'the device is locked — too many wrong PINs. Recovery is a factory reset, which destroys every identity',
  },
  0x6982: {
    code: 'SW_PIN_SESSION_REQUIRED',
    message: 'the device requires its PIN before this operation — verify to continue',
  },
};

/** The mapping for one status word; unknown words are typed device-error. */
export function describeSw(sw) {
  const known = SW_ERROR_MAP[sw];
  if (known) return { ...known, known: true };
  return {
    code: 'device-error',
    message: `the device answered 0x${sw.toString(16).padStart(4, '0')} — no known sentence for it`,
    known: false,
  };
}

/** US-1734 board run — the sentence an error carries wherever the worker
 *  speaks to a page (the settle push, the port boundary). A status-word
 *  error renders its typed sentence; on hardware the prompt window showed
 *  the raw word ("SIGN refused with 0x6985") where this sentence belongs.
 *  Errors without a status word keep their own message. */
export function errSentence(err) {
  return err && err.sw !== undefined ? describeSw(err.sw).message : (err?.message ?? '');
}
