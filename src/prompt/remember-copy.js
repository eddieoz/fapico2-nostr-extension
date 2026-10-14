// US-1720 — the remember-checkbox copy, extracted pure so the two load-bearing
// clauses are pinned and cannot silently regress. It reads as one short sentence
// naming the site, and keeps BOTH facts the store actually delivers: the grant
// covers this site for THIS action only, and the device touch is still required
// every time. It never promises "never asked again" — session-only grants die
// with the worker, so that wording would lie (the footnote still carries the
// touch = final-consent rule; that stays in prompt.html, unchanged).
export function rememberCopy(host) {
  const site = host && host !== 'unknown site' ? host : 'this site';
  return `Remember this choice for ${site} — for this action only; the device touch is still required every time.`;
}
