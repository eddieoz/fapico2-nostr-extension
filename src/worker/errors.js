// US-1692/US-1707 — the worker's typed error vocabulary. Every failure that
// crosses a port is {name, message, code} — a raw Error never crosses.
// The device-side types (DeviceAbsentError, SwError, CeremonyInterruptedError,
// CtapError) come from the ported core; this module adds the worker's own and
// the single serialization point for the port boundary.

import { DeviceAbsentError } from '../core/loudness.js';
import { errSentence } from './error-map.js';

/** A request the dispatch refuses before any handler runs. */
export class UnsupportedMethodError extends Error {
  constructor(method) {
    super(`${method} is not in the dispatch table`);
    this.name = 'UnsupportedMethodError';
    this.code = 'unsupported-method';
  }
}

/** A management method called from outside an extension page. */
export class ForbiddenMethodError extends Error {
  constructor(method) {
    super(`${method} is extension-page-only — relayed (tab) senders are refused`);
    this.name = 'ForbiddenMethodError';
    this.code = 'forbidden-method';
  }
}

/** The serialization queue is bounded; overflow is typed, not unbounded. */
export class QueueFullError extends Error {
  constructor(depth) {
    super(`device queue full (${depth} requests) — try again when the current operation settles`);
    this.name = 'QueueFullError';
    this.code = 'device-queue-full';
  }
}

export const CEREMONY_INTERRUPTED = {
  name: 'CeremonyInterruptedError',
  code: 'CEREMONY_INTERRUPTED',
  message: 'ceremony interrupted — the worker restarted mid-operation; try again',
};

export const USER_DENIED = {
  name: 'UserDeniedError',
  code: 'user-denied',
  message: 'the request was denied',
};

export function serializeError(err) {
  if (err && typeof err === 'object') {
    // US-1707: the typed vocabulary is the only thing that crosses a port.
    // A raw TypeError/SecurityError/HID internal is rebranded internal-error
    // — still typed, never a raw name the page would have to guess at.
    if (!TYPED_NAMES.has(err.name)) {
      return {
        name: 'InternalError',
        code: 'internal-error',
        message: String(err.message ?? err),
      };
    }
    return {
      name: err.name,
      // US-1734 board run — a status-word error crosses the port with its
      // typed sentence, never the raw word; the sw rides for machines.
      message: errSentence(err) || String(err.message ?? err),
      code: err.code ?? err.name,
      sw: err.sw,
      device: err.device,
    };
  }
  // A thrown string/Symbol/number: typed, with the text kept for the user.
  return { name: 'InternalError', code: 'internal-error', message: String(err) };
}

/** US-1707 — the typed vocabulary, single source of truth for the port
 *  boundary. Everything else is rebranded InternalError. */
export const TYPED_NAMES = new Set([
  'DeviceAbsentError',
  'SwError',
  'SignerError',
  'CtapError',
  'CeremonyInterruptedError',
  'UserDeniedError',
  'UnsupportedMethodError',
  'ForbiddenMethodError',
  'QueueFullError',
  'PortDisconnectedError',
  'PermissionRequiredError',
  'RateLimitError',
  'PayloadTooLargeError',
  'InternalError',
]);

export function reviveError(blob) {
  if (!blob || typeof blob !== 'object') return new Error(String(blob));
  const err = new Error(blob.message);
  err.name = blob.name;
  err.code = blob.code;
  if (blob.sw !== undefined) err.sw = blob.sw;
  if (blob.device !== undefined) err.device = blob.device;
  return err;
}

/** Typed absent error, reusing the core's loud type. */
export function deviceAbsent(device = 'Fapico board') {
  return new DeviceAbsentError(device);
}
