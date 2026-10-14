// US-1671 — the loud signer (design D10, §3.2). Three properties, each a
// decision this module makes so callers cannot quietly unmake it:
//
//   - **No silent fallback.** A signature that is not hardware-backed with
//     no visible signal puts the nsec in the browser process — the exact
//     exposure the device exists to remove. So the signer is *chosen*,
//     never resolved by availability: createSignerSource returns the mode
//     it was given or throws. SoftwareSigner exists for the test suite and
//     for a user who explicitly chose software-only — never as a fallback.
//   - **Device-absent is typed and loud.** `DeviceAbsentError` names the
//     device; the indicator state is visible and non-dismissible — there is
//     no timeout and no dismiss call. Only the device actually answering
//     clears it.
//   - **Refused, not queued.** Nothing in this module holds a pending
//     request. A request that arrives with no device fails on its own
//     merits (§3.2: a signature produced at an unknown time on an unknown
//     machine is a plausible one).

export const SignerKinds = {
  HARDWARE: 'fapico-hardware',
  SOFTWARE: 'software',
};

export class DeviceAbsentError extends Error {
  constructor(device = 'Fapico board') {
    super(`no ${device} connected — connect it and try again`);
    this.name = 'DeviceAbsentError';
    this.code = 'DEVICE_ABSENT';
    this.device = device;
  }
}

const ABSENT_SHAPES = new Set(['NotFoundError', 'AbortError', 'NotAllowedError']);

/**
 * Map a transport/chooser failure to the typed absence error. Genuine
 * device errors (DEVICE_ERROR, TIMEOUT…) pass through untouched — rebranding
 * them would be the quiet failure mode this module exists to prevent.
 */
export function mapDeviceError(err, device = 'Fapico board') {
  if (err instanceof DeviceAbsentError) return err;
  if (err?.code === 'DEVICE_ABSENT') return new DeviceAbsentError(err.device ?? device);
  if (ABSENT_SHAPES.has(err?.name)) return new DeviceAbsentError(device);
  return err;
}

const MODE_TO_KIND = {
  hardware: SignerKinds.HARDWARE,
  software: SignerKinds.SOFTWARE,
  [SignerKinds.HARDWARE]: SignerKinds.HARDWARE,
  [SignerKinds.SOFTWARE]: SignerKinds.SOFTWARE,
};

/**
 * Explicit signer resolution. `mode` is the whole decision: whichever
 * implementation is named is the one returned; there is no availability
 * check and no alternative.
 */
export function createSignerSource({ mode, hardware, software }) {
  const kind = MODE_TO_KIND[mode];
  if (kind === SignerKinds.HARDWARE) {
    return { kind, get: hardware };
  }
  if (kind === SignerKinds.SOFTWARE) {
    return { kind, get: software };
  }
  throw new Error(`no signer chosen — mode "${mode}" is not one the user picked`);
}

/**
 * The popup indicator state. `persist` (the entry wires chrome.storage.
 * session) is called after every transition; the popup renders whatever it
 * reads, and `deviceAbsent` has no dismiss path — it clears only when the
 * hardware actually produces a signature.
 */
export function createSignerIndicator({ now = () => Date.now(), persist = () => {} } = {}) {
  const state = { lastSignature: null, deviceAbsent: null, ceremonyInterrupted: null };
  return {
    snapshot() {
      return {
        lastSignature: state.lastSignature ? { ...state.lastSignature } : null,
        deviceAbsent: state.deviceAbsent ? { ...state.deviceAbsent } : null,
        ceremonyInterrupted: state.ceremonyInterrupted
          ? { ...state.ceremonyInterrupted }
          : null,
      };
    },
    // §A.8.3b #4 — MV3 worker suspension mid-ceremony after a real press:
    // the page sees the typed CEREMONY_INTERRUPTED and the popup says
    // "ceremony interrupted — try again". Like deviceAbsent it is
    // non-dismissible: only the device answering again clears it.
    noteCeremonyInterrupted({ at = now() } = {}) {
      state.ceremonyInterrupted = { at };
      persist(state);
    },
    noteSignature(signer, { at = now() } = {}) {
      state.lastSignature = { signer, at };
      if (signer === SignerKinds.HARDWARE) {
        // The device answered: the absence warning is obsolete, and so is
        // any stale interruption — this signature is proof of a live,
        // completed ceremony.
        state.deviceAbsent = null;
        state.ceremonyInterrupted = null;
      }
      persist(state);
    },
    noteDeviceAbsent(device = 'Fapico board') {
      state.deviceAbsent = { device, at: now() };
      persist(state);
    },
  };
}
