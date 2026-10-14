// US-1718 — the prompt request-block rendering decision, extracted pure so the
// headline/chip mapping is testable without the DOM. The worker's preview (the
// specific thing being asked) is the headline; the raw method name is the chip.
// A method the worker did not phrase — or an unknown one — has no preview, so
// the raw name fills the headline and the block is never empty. The preview is
// still escaped on the way into the DOM (metadata-only invariant); that is a
// rendering concern, so it stays in prompt.js, not here.
export function requestRender(preview, method) {
  const m = String(method ?? '');
  return { chip: m || 'unknown', headline: (preview ?? '').trim() || m || 'unknown' };
}
