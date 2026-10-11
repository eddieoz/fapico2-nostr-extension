// US-1672 — batched decryption that never marks a miss as done; SW
// suspension covered (design D14, §2.3, §A.8.3b). One user gesture drives
// the whole visible set, but every item is its own touch-gated ceremony —
// silent decryption would make the device an oracle.
//
// The rule the old autoDecryptAllXryptTexts loop broke (§2.3): it marked
// elements processed regardless of outcome, turning a security property
// into silent data loss. Here `markDone` fires only on success; a miss is
// reported (onRetry) and retried in a later pass — and if it never
// succeeds, it stays unmarked and in the result, never silently dropped.
//
// MV3 service-worker suspension can strand a *touched* ceremony
// (§A.8.3 #5): the ceremony holds a keepalive loop while it runs, and
// termination after a real press surfaces as a typed
// CeremonyInterruptedError — distinct from DEVICE_ABSENT and from
// refusals — with the batch result reporting exactly what was and was not
// processed. Nothing is stranded silently.
//
// NOTE (US-1684): `decryptBatch` has **no production caller yet** — the
// shipped auto-decrypt loop keeps its own `allSucceeded` gate
// (src/content.js, the `if (allSucceeded) markDecrypted(el)` decision), and
// nobody may assume the batch path is live. The parent epic wired the
// machinery and tested it; this note is what stops that assumption from
// calcifying. Wiring the batch into the shipped loop is future work.

export const TOUCH_WINDOW_MS = 15_000;
export const KEEPALIVE_PERIOD_MS = 20_000;

export class CeremonyInterruptedError extends Error {
  constructor(message = 'ceremony interrupted — try again') {
    super(message);
    this.name = 'CeremonyInterruptedError';
    this.code = 'CEREMONY_INTERRUPTED';
  }
}

/**
 * Hold the service worker alive while a ceremony runs (MV3 resets the
 * 30 s SW lifetime on extension-API activity): `tick` is called every
 * `periodMs` until `stop()`. `stop` is idempotent and the loop does not
 * outlive the ceremony.
 */
export function startKeepalive({ tick = () => {}, periodMs = KEEPALIVE_PERIOD_MS } = {}) {
  const handle = setInterval(tick, periodMs);
  let stopped = false;
  return {
    tick,
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(handle);
    },
  };
}

/**
 * The 15 s touch-window countdown (§A.8.3b #8): `onTick(remainingMs)` fires
 * every `tickMs` until the window lapses at zero — so a user racing a
 * suppressible LED can see the time remaining. Returns `stop()`.
 */
export function startWindowCountdown({
  windowMs = TOUCH_WINDOW_MS,
  tickMs = 250,
  onTick = () => {},
  now = () => Date.now(),
} = {}) {
  const startedAt = now();
  const handle = setInterval(() => {
    const remaining = Math.max(0, windowMs - (now() - startedAt));
    onTick(remaining);
    if (remaining === 0) stop();
  }, tickMs);
  let stopped = false;
  function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(handle);
  }
  return { stop };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Decrypt `items` in order, one touch-gated ceremony each.
 *
 *   decryptOne(item) -> plaintext   the per-item ceremony; throw to miss
 *   isDone(item) -> bool            skip already-processed items
 *   markDone(item)                  called ONLY on success — never on a
 *                                   miss, never on an interruption
 *   onRetry(item, err)              a miss, reported as it happens
 *   onWindowTick(item, remainingMs) the 15 s countdown feed
 *   passes                          how many retry passes missed items get
 *
 * A CeremonyInterruptedError aborts the whole batch — retrying into a dead
 * service worker is pointless — and the result names the interruption:
 * `{done, missed, unprocessed, interrupted}` where interrupted is
 * `{item, error}`, every earlier success is already marked, and every item
 * that was never attempted is named in `unprocessed` (US-1682) — the
 * complete fate of every input item, each in exactly one place.
 */
export async function decryptBatch({
  items,
  decryptOne,
  isDone = () => false,
  markDone = () => {},
  onRetry = () => {},
  onWindowTick,
  keepaliveTick,
  windowMs = TOUCH_WINDOW_MS,
  passes = 1,
}) {
  const keepalive = startKeepalive({ tick: keepaliveTick });
  const result = { done: [], missed: [], unprocessed: [], interrupted: null };
  const misses = new Map();
  try {
    let pending = items.filter((item) => !isDone(item));
    for (let pass = 0; pass <= passes && pending.length > 0; pass++) {
      const next = [];
      for (const item of pending) {
        if (result.interrupted) break;
        if (isDone(item)) continue;
        const countdown =
          onWindowTick && startWindowCountdown({ windowMs, onTick: (r) => onWindowTick(item, r) });
        try {
          const plaintext = await decryptOne(item);
          // The only path that marks a thing done.
          markDone(item, plaintext);
          result.done.push(item);
          misses.delete(item);
        } catch (err) {
          if (err?.code === 'CEREMONY_INTERRUPTED') {
            // SW suspension mid-ceremony: fail closed, name it, stop.
            result.interrupted = { item, error: err };
            break;
          }
          misses.set(item, err);
          onRetry(item, err);
          next.push(item);
        } finally {
          countdown?.stop();
        }
      }
      pending = next;
      if (pass + 1 < passes) {
        // A macrotask yield: the retry pass runs in a fresh timeout, so
        // touch windows that already lapsed are closed out by the event
        // loop before the retries begin — the spacing is the yield itself,
        // not a timed delay.
        await sleep(0);
      }
    }
    // US-1682: the result names the complete fate of every input item.
    // `misses` holds every attempted-and-failed item that has not since
    // succeeded; the interrupted item is named once, in `interrupted`; and
    // an interrupted run additionally names the unattempted remainder in
    // `unprocessed` — an unattempted item is distinguishable from an
    // attempted-and-failed one, and nothing after the interruption
    // disappears from the report.
    result.missed = [...misses.entries()]
      .filter(([item]) => !isDone(item) && item !== result.interrupted?.item)
      .map(([item, error]) => ({ item, error }));
    if (result.interrupted) {
      const attempted = new Set([...misses.keys(), ...result.done]);
      result.unprocessed = items.filter(
        (item) => !isDone(item) && item !== result.interrupted.item && !attempted.has(item),
      );
    }
  } finally {
    keepalive.stop();
  }
  return result;
}
