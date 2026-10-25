// US-1718 — the prompt's request block is ONE sentence: the worker's preview
// (the specific thing being asked) as the headline, with the raw method name
// as a small chip, and the old generic "This site wants to …" METHOD_WORDS
// sentence is gone. No jsdom in this repo, so the pure renderer is asserted
// directly and the page/JS/CSS are parsed as text (the DOM-hook facts are all
// that a render would prove here).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requestRender } from '../src/prompt/request-render.js';
import { rememberCopy } from '../src/prompt/remember-copy.js';
import { settleBeat, successBeat, TOUCH_TEXT, LOST_CONNECTION_TEXT } from '../src/prompt/touch-state.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFile(join(root, p), 'utf8');

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** The first top-level `selector { ... }` block whose selector matches `re`. */
function block(css, re) {
  const m = css.match(new RegExp(`${re.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([\\s\\S]*?)\\}`));
  return m ? m[1] : null;
}

test('US-1718 the preview is the headline and the raw method is the chip', () => {
  const r = requestRender('signs a short text note — "hi"', 'sign_event');
  assert.equal(r.headline, 'signs a short text note — "hi"');
  assert.equal(r.chip, 'sign_event');
});

test('US-1718 an unknown method (no preview) renders the raw name as the headline — never empty', () => {
  const r = requestRender('', 'sign_thing');
  assert.equal(r.headline, 'sign_thing');
  assert.equal(r.chip, 'sign_thing');
});

test('US-1718 a method with neither preview nor name still fills the headline', () => {
  const r = requestRender('', '');
  assert.equal(r.headline, 'unknown');
  assert.notEqual(r.headline, '');
});

test('US-1718 the generic METHOD_WORDS sentence is gone from prompt.js', async () => {
  const js = await read('src/prompt/prompt.js');
  assert.ok(!/sign a Nostr event with your device key/.test(js), 'no METHOD_WORDS generic sentence');
  assert.ok(!/This site wants to/.test(js), 'no "This site wants to" wrapper');
  assert.ok(!/METHOD_WORDS/.test(js), 'the METHOD_WORDS map is removed');
});

test('US-1718/US-1738 prompt.js drives the chip and headline hooks from requestRender — the sink is raw textContent', async () => {
  const js = await read('src/prompt/prompt.js');
  assert.ok(/import \{ requestRender \} from '\.\/request-render\.js'/.test(js), 'imports the pure renderer');
  assert.ok(/\$\('method-chip'\)\.textContent = render\.chip/.test(js), 'the chip hook is set from the renderer');
  assert.ok(/\$\('headline'\)\.textContent = render\.headline/.test(js), 'the headline hook is set verbatim (US-1738: the textContent sink is safe by construction)');
});

// US-1738 — the escapeHtml wrapper was load-bearing for the old innerHTML
// sink; kept around the new textContent assignment it double-escaped any
// preview containing & < > " (e.g. an event's content summary). The sink is
// safe by construction, so the escape layer is removed, not doubled.
test('US-1738 no escapeHtml remains in the prompt page — the preview renders verbatim', async () => {
  const js = await read('src/prompt/prompt.js');
  assert.doesNotMatch(js, /escapeHtml/, 'no escape layer between the preview and the textContent sink');
});

test('US-1718 prompt.html carries the chip and headline hooks inside the request block', async () => {
  const html = await read('src/prompt/prompt.html');
  assert.ok(/id="method-chip"/.test(html), 'the chip hook exists');
  assert.ok(/id="headline"/.test(html), 'the headline hook exists');
  assert.ok(/id="wants"/.test(html), 'the request block wrapper is kept');
});

test('US-1718 prompt.css styles the chip as a neutral tag, not an amber sentence', async () => {
  const css = stripComments(await read('src/prompt/prompt.css'));
  assert.ok(/\.method-chip\s*\{/.test(css), 'the chip rule exists');
  assert.ok(!/\.what\s*\{/.test(css), 'the old .what sentence span is gone');
});

// US-1719 — the identity row must not shift the buttons: it reserves one line
// always (min-height, and a hidden identity stays in flow) and reads advisory.
test('US-1719 the identity row reserves one line even when omitted — never drops out of flow', async () => {
  const css = stripComments(await read('src/prompt/prompt.css'));
  const rule = block(css, '\.request-identity');
  assert.ok(rule, 'the identity rule exists');
  assert.ok(/min-height:/.test(rule), 'a min-height reserves the line in every state');
  const hidden = css.match(/\.request-identity\[hidden\]\s*\{([^}]*)\}/);
  assert.ok(hidden, 'the [hidden] override selector exists');
  assert.ok(hidden && !/display:\s*none/.test(hidden[1]), 'a hidden identity stays in flow (space reserved)');
});

test('US-1719 the identity row is advisory — one step stronger than dim, never an alarm', async () => {
  const css = stripComments(await read('src/prompt/prompt.css'));
  const rule = block(css, '\.request-identity');
  assert.ok(/color:\s*var\(--ink\)/.test(rule), 'stronger than the --ink-dim chassis text');
  assert.ok(!/var\(--err\)|var\(--amber\)/.test(rule), 'no error/amber alarm styling');
});

// US-1720 — the remember copy is one short sentence naming the site but keeps
// BOTH clauses the store actually delivers, and never over-promises. The pure
// renderer is asserted directly; the wiring (checkbox gates only `remember`,
// the touch footnote stays) is asserted on the source.
test('US-1720 remember copy names the site and pins both load-bearing clauses', () => {
  const c = rememberCopy('snort.social');
  assert.ok(c.includes('snort.social'), 'names the site');
  assert.ok(c.includes('for this action only'), 'clause 1: this site, for this action only');
  assert.ok(c.includes('the device touch is still required every time'), 'clause 2: touch still required every time');
});

test('US-1720 remember copy never promises "never asked again" beyond what the store delivers', () => {
  assert.ok(!/asked again|never asked|not be asked/i.test(rememberCopy('snort.social')), 'no over-promise');
  assert.ok(/this site/.test(rememberCopy('')), 'an unknown host falls back without a false site name');
});

test('US-1720 the over-promising "asked again" copy is gone; the touch footnote stays', async () => {
  const html = await read('src/prompt/prompt.html');
  assert.ok(!/will not be asked again|not be asked again|never asked/i.test(html), 'the over-promising copy is gone');
  assert.ok(/is the final consent/i.test(html), 'the touch = final-consent footnote is unchanged');
});

test('US-1720 the checkbox still gates only `remember` — the decision payload is unchanged', async () => {
  const js = await read('src/prompt/prompt.js');
  const reads = js.match(/\$\('remember'\)\.checked/g) ?? [];
  assert.equal(reads.length, 1, 'the checkbox value feeds exactly one field');
  assert.ok(/remember:\s*\$\('remember'\)\.checked/.test(js), 'and that field is `remember`');
});

// US-1724 — the outcome beat is pure text (success confirmation, or the typed
// error sentence VERBATIM); the page is a thin driver over it.
test('US-1724 the success beat is a short, method-aware confirmation', () => {
  assert.equal(settleBeat('sign_event', { outcome: 'ok' }).text, 'signed.');
  assert.equal(settleBeat('sign_event', { outcome: 'ok' }).err, false);
  assert.equal(successBeat('get_public_key'), 'shown.');
});

test('US-1724 the error beat renders the typed sentence verbatim — never generic', () => {
  const sentence = 'the device was not touched (6985)';
  const beat = settleBeat('sign_event', { outcome: 'err', message: sentence });
  assert.equal(beat.text, sentence, 'the typed message rides the settle push unchanged');
  assert.equal(beat.err, true);
  assert.ok(!/generic|failed|an error|something went wrong/i.test(beat.text.toLowerCase()), 'no generic wording replaces it');
});

test('US-1724 the touch bar and lost-connection copy are the shared language', () => {
  assert.equal(TOUCH_TEXT, 'touch your fapico2 board');
  assert.equal(LOST_CONNECTION_TEXT, 'connection to the extension was lost — check the site');
});

// US-1724 — Approve flips to the touch state and the window STAYS OPEN through
// the device touch (D-UX6); it no longer closes on approve. Deny still closes
// instantly. Both handlers are extracted by their `addEventListener('click', …)`
// body so the approve/deny assertions can't cross each other.
function handler(js, which) {
  const m = js.match(new RegExp(`\\$\\('${which}'\\)\\.addEventListener\\('click',\\s*\\(\\)\\s*=>\\s*\\{([\\s\\S]*?)\\}\\);`));
  return m ? m[1] : '';
}

test('US-1724 Approve resolves then flips to the touch state — no immediate close (D-UX6)', async () => {
  const js = await read('src/prompt/prompt.js');
  const body = handler(js, 'approve');
  assert.ok(body, 'the approve handler exists');
  assert.ok(/showTouch|touch-bar/.test(body), 'approve flips to the touch state');
  assert.ok(!/window\.close\(\)/.test(body), 'approve does NOT close the window immediately');
});

test('US-1724 Deny keeps its instant close', async () => {
  const js = await read('src/prompt/prompt.js');
  const body = handler(js, 'deny');
  assert.ok(body, 'the deny handler exists');
  assert.ok(/window\.close\(\)/.test(body), 'deny still closes instantly');
});

// US-1724 — the page subscribes to the worker's push (prompt-settled) and to
// disconnect, and drives the outcome beat from the settle frame.
test('US-1724 the page consumes prompt-settled and disconnect, and drives the outcome beat from the frame', async () => {
  const js = await read('src/prompt/prompt.js');
  assert.ok(/api\.onEvent\(\(frame\)\s*=>/.test(js), 'subscribes to worker push frames');
  assert.ok(/prompt-settled/.test(js), 'handles the prompt-settled frame');
  // The settle frame drives the beat — inline or via a local, the sentence
  // comes from settleBeat(method, frame); an error beat keeps the window open
  // (the sentence is the diagnosis — the chat.nostr.com field run).
  assert.ok(/settleBeat\(method,\s*frame\)/.test(js), 'the beat is derived from the settle frame');
  assert.ok(/showOutcome\(/.test(js), 'the outcome beat is shown');
  assert.ok(/api\.onDisconnect\(\(\)\s*=>/.test(js), 'subscribes to disconnect');
  assert.ok(/LOST_CONNECTION_TEXT|connection to the extension was lost/.test(js), 'shows the lost-connection notice');
});

// US-1724 — the DOM carries the touch-bar and outcome hooks.
test('US-1724 prompt.html carries the touch-bar and outcome hooks', async () => {
  const html = await read('src/prompt/prompt.html');
  assert.ok(/id="touch-bar"/.test(html), 'the touch-bar hook exists');
  assert.ok(/id="touch-text"/.test(html), 'the touch-bar text hook exists');
  assert.ok(/id="outcome"/.test(html), 'the outcome beat hook exists');
  assert.ok(/id="actions"/.test(html), 'the actions wrapper is hookable');
  assert.ok(/touch your fapico2 board/.test(html), 'the touch bar language matches the popup');
});

// US-1724 — the touch bar (amber, pulsing) and outcome beat are styled; the
// pulse is the shared primitive, not redefined per page.
test('US-1724 prompt.css styles the touch bar and outcome beat', async () => {
  const css = stripComments(await read('src/prompt/prompt.css'));
  assert.ok(/\.touch-bar\s*\{/.test(css), 'the touch-bar rule exists');
  assert.ok(/\.touch-bar\.on\s*\{[^}]*animation:\s*pulse/.test(css), 'the active touch bar pulses the shared keyframe');
  assert.ok(/\.outcome\s*\{/.test(css), 'the outcome beat rule exists');
  assert.ok(/\.outcome\.err\s*\{/.test(css), 'the error outcome is styled loud');
  const errRule = block(css, '.outcome.err');
  assert.ok(errRule && errRule.includes('var(--err)'), 'the error outcome uses --err');
});

test('US-1724 the pulse primitive is shared (tokens.css), not duplicated per page', async () => {
  const tokens = await read('src/popup/tokens.css');
  assert.ok(/@keyframes\s+pulse/.test(tokens), 'tokens.css defines the shared pulse');
  const popupCss = stripComments(await read('src/popup/popup.css'));
  assert.ok(!/keyframes\s+pulse/.test(popupCss), 'popup.css no longer defines its own pulse');
});

// US-1741 — self-healing ports mean an approve can reach a RESTARTED worker,
// where the in-memory outstanding record is gone and decide() answers
// {delivered: false}. The page must fail LOUD (the lost-connection notice) —
// never flip to the touch bar for a decision nobody holds (a silent hang).
test('US-1741 the approve handler fails loud on a lost decision — never a touch bar without a consent record', async () => {
  const js = await read('src/prompt/prompt.js');
  const body = handler(js, 'approve');
  assert.ok(body, 'the approve handler exists');
  assert.match(body, /delivered\s*===?\s*false/, 'it checks the decide() answer');
  assert.match(body, /showLostConnection\(\)/, 'a lost decision shows the lost-connection notice');
});
