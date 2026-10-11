// The consent gate (US-1699/1700/1701): the function the handlers call
// before any device work on a relayed (tab) request. Order is fixed:
// persisted grant → immediate; session grant → immediate; otherwise the
// prompt window — and the device is touched only after the decision.
// A trusted extension-page sender never reaches this gate.

import { USER_DENIED } from './errors.js';

export function hostFromSender(sender) {
  const raw = sender?.url ?? sender?.origin ?? sender?.tab?.url;
  if (typeof raw !== 'string' || raw.length === 0) return 'unknown';
  try {
    return new URL(raw).host || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * `permissions` is the US-1699 store; `prompt` the US-1700 flow. `hostOf`
 * is injectable for tests; production derives it from sender.url — the
 * page's own location.host (attached by the provider) is untrusted data and
 * is used only as a display cross-check.
 */
export function createConsentGate({
  permissions,
  prompt,
  pending = null,
  portName = () => 'nostr-consent',
  hostOf = hostFromSender,
  previewOf = null,
} = {}) {
  return async function consent({ method, args, sender, requestId, preview }) {
    const host = hostOf(sender);
    const granted = await permissions.check(host, method);
    if (granted) return { host, method, grant: granted };

    // The device is NOT touched here. The prompt renders first.
    const shown = preview ?? previewOf?.(method, args) ?? '';
    if (pending && requestId != null) {
      await pending.begin({
        id: requestId,
        method,
        preview: shown,
        host,
        portName: portName(sender),
      });
    }
    let decision;
    try {
      decision = await prompt.ask({ requestId, method, host, preview: shown });
    } catch (err) {
      // Window closed or denied: typed, loud, and the pending record is
      // settled so a restarted worker re-delivers the refusal.
      const denial = { error: { ...USER_DENIED, message: err?.message ?? USER_DENIED.message } };
      if (pending && requestId != null) await pending.settle(requestId, denial);
      const e = new Error(denial.error.message);
      e.name = denial.error.name;
      e.code = denial.error.code;
      throw e;
    }

    if (decision.remember) {
      await permissions.grant(host, [method]);
    } else {
      permissions.grantSession(host, [method]);
    }
    const outcome = { result: { consented: true } };
    if (pending && requestId != null) await pending.settle(requestId, outcome);
    return { host, method, grant: 'new', remember: decision.remember };
  };
}
