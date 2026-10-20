// US-1670 — the window.nostr bridge's error serializers. The bridge's two
// halves (the isolated-world relay and the MAIN-world provider) were replaced
// by src/content/bridge.js and src/provider/provider.js (US-1696/1697/1698);
// only these two serializers are still imported — by provider.js and
// bridge.js — to carry a typed error across the postMessage boundary. The
// dead half (installPageNostr, attachNostrBridge, createNostrBridge, the
// PAGE_METHODS table, and the dead second marker) was never wired into any
// bundle and is deleted (US-1750); the live marker fapico:nostr:1 lives in
// shared/protocol.js.

export function serializeBridgeError(err) {
  return {
    name: err.name,
    code: err.code ?? err.name,
    sw: err.sw,
    message: String(err.message ?? err),
  };
}

export function reviveBridgeError(blob) {
  const err = new Error(blob.message);
  err.name = blob.name;
  err.code = blob.code;
  err.sw = blob.sw;
  return err;
}
