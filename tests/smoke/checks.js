// US-1708 — the regression tripwire: the manifest shape that kills NIP-07
// on Chrome 154 (verified live, 2026-10-11). When the same content-script
// FILE is declared in both the isolated world and `world: "MAIN"`, Chrome
// injects it only ONCE — the MAIN-world provider silently vanishes and
// window.nostr never exists. The smoke test asserts the live page; this
// check asserts the manifest itself, and a fixture copy of the OpenXrypt
// shape must trip it (tests/smoke/tripwire.test.js).

export function manifestTripwire(manifest) {
  const entries = manifest?.content_scripts ?? [];
  const isolated = new Set();
  const mainWorld = new Set();
  for (const entry of entries) {
    const target = entry.world === 'MAIN' ? mainWorld : isolated;
    for (const file of entry.js ?? []) target.add(file);
  }
  for (const file of mainWorld) {
    if (isolated.has(file)) {
      return `content script "${file}" is declared in both the isolated world and world: "MAIN" — Chrome injects it once and the MAIN-world provider vanishes (the OpenXrypt P0)`;
    }
  }
  return null;
}
