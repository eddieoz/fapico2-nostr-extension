// US-1692 — the port-based messaging spine. Any extension page (or, relayed
// through the bridge, any page) opens a `chrome.runtime.connect` port named
// `nostr-<seq>` and sends `{id, method, args}` frames; the worker routes each
// frame to the method table and answers `{id, result}` or
// `{id, error: {name, message, code?}}`. A method outside the table is
// refused `unsupported-method` — never a silent no-op, never an undefined
// reply.
//
// The sender gate: the five page-allowed methods are relayed from tabs;
// everything else (pairing, key management, grants, prompt decisions) is
// extension-page-only, enforced by checking `sender.url` starts with
// `chrome-extension://<this id>/` (the Flamingo isTrustedExtensionSender
// pattern, original implementation).
//
// The table is data: one map, one shape — not a switch spread across files.

import { serializeError } from './errors.js';

export const PAGE_ALLOWED_METHODS = new Set([
  'get_public_key',
  'sign_event',
  'list_keys',
  'nip44_encrypt',
  'nip44_decrypt',
]);

export const TRUSTED_ONLY_METHODS = new Set([
  'echo',
  'device_status',
  'pair_device',
  'generate_key',
  'import_key',
  'delete_key',
  'set_label',
  'export_key',
  'get_grants',
  'revoke_grant',
  'revoke_all',
  'prompt_decision',
  'get_active_slot',
  'set_active_slot',
]);

/** The Flamingo sender gate, original implementation. */
export function isTrustedExtensionSender(sender, extensionId = chrome.runtime.id) {
  return (
    typeof sender?.url === 'string' &&
    sender.url.startsWith(`chrome-extension://${extensionId}/`)
  );
}

/**
 * Build the dispatcher. `methods` maps a method name to a handler
 * `(args, context) -> result` (throws typed errors on refusal); `context`
 * carries `{sender, port}`. The handler set must be closed over the two
 * known sets: anything not listed is refused `unsupported-method`.
 */
export function createDispatch(methods, { extensionId = chrome.runtime.id } = {}) {
  return async function route(frame, sender, port) {
    const id = frame?.id;
    const method = frame?.method;
    if (typeof id === 'undefined' || typeof method !== 'string') {
      return null; // not a frame — nothing to answer, nothing to hang
    }
    const reply = (payload) => ({ id, ...payload });

    if (!Object.hasOwn(methods, method)) {
      return reply({
        error: serializeError(
          Object.assign(new Error(`${method} is not in the dispatch table`), {
            name: 'UnsupportedMethodError',
            code: 'unsupported-method',
          }),
        ),
      });
    }

    const trusted = isTrustedExtensionSender(sender, extensionId);
    const pageAllowed = PAGE_ALLOWED_METHODS.has(method);
    if (!trusted && !pageAllowed) {
      return reply({
        error: serializeError(
          Object.assign(new Error(`${method} is extension-page-only`), {
            name: 'ForbiddenMethodError',
            code: 'forbidden-method',
          }),
        ),
      });
    }

    try {
      // US-1735 — frame ids are per-connection counters (the provider's `p0…`
      // per page, the port client's `c0…` per popup) while the worker's
      // request maps are global: two tabs' concurrent first calls both arrive
      // as `p0` and the second overwrites the first. The composite keeps the
      // two apart; the REPLY below still echoes the bare frame id, because
      // the bridge and the provider match replies by it. A direct route call
      // with no port (the test-runner shape) keeps the bare id.
      const requestId = port ? `${port.name}/${id}` : id;
      const result = await methods[method](frame.args ?? [], {
        sender,
        port,
        trusted,
        requestId,
      });
      return reply({ result });
    } catch (err) {
      return reply({ error: serializeError(err) });
    }
  };
}

/**
 * Wire one connected port to the dispatcher: every `{id, method, args}`
 * frame on the port gets exactly one reply frame. Frames that are not
 * calls are ignored (the port also carries prompt-page decisions etc. —
 * those arrive as calls in their own right).
 */
export function attachPortListener(port, route) {
  port.onMessage.addListener(async (frame) => {
    const reply = await route(frame, port.sender ?? null, port);
    if (reply) port.postMessage(reply);
  });
}
