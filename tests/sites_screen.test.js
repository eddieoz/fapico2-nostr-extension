// US-1701 — remember-this-site + the Sites revocation screen: approve with
// "remember" persists the (host, method) grant and future calls skip the
// prompt (the device is still called); revoke and the next call prompts
// again. A grant covers exactly the methods approved; "Revoke all" exists.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPermissionStore } from '../src/worker/permissions.js';
import { createPromptFlow } from '../src/worker/prompt.js';
import { createConsentGate } from '../src/worker/consent.js';
import { createRevokeAllArmer } from '../src/popup/revoke-all.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readPopup = () => readFile(join(root, 'src/popup/popup.js'), 'utf8');

function fakeStorage() {
  const data = new Map();
  return {
    async get(k) { const out = {}; for (const key of [].concat(k)) if (data.has(key)) out[key] = data.get(key); return out; },
    async set(o) { for (const [k, v] of Object.entries(o)) data.set(k, v); },
    async remove(k) { data.delete(k); },
  };
}

function fakeWindows() {
  const removedListeners = [];
  let nextId = 200;
  return {
    createdCount: 0,
    create: async () => ({ id: nextId++ }),
    onRemoved: { addListener: (fn) => removedListeners.push(fn) },
    get created() {
      return this.createdCount;
    },
    bump() {
      this.createdCount++;
    },
  };
}

function rig() {
  const storage = fakeStorage();
  const permissions = createPermissionStore({ storage });
  const windows = fakeWindows();
  const prompt = createPromptFlow({ windows });
  const consent = createConsentGate({ permissions, prompt, hostOf: () => 'site.example' });
  return { permissions, prompt, consent, windows, storage };
}

const sender = { url: 'https://site.example/feed' };

async function answerPrompt(prompt, requestId, { approve, remember }) {
  // The prompt page's decision arrives via the dispatch; here directly,
  // after ask()'s async body has registered the request.
  await new Promise((r) => setImmediate(r));
  await prompt.decide({ requestId, approve, remember });
}

test('US-1701 remember → persisted → the second call skips the prompt (device still called)', async () => {
  const { permissions, prompt, consent, windows } = rig();
  const order = [];
  const runDevice = async () => order.push('device');

  // First call: prompts; approve with remember.
  windows.bump();
  const gate1 = consent({ method: 'sign_event', args: [{ kind: 1 }], sender, requestId: 'r1' });
  await answerPrompt(prompt, 'r1', { approve: true, remember: true });
  await gate1;
  await runDevice();
  assert.deepEqual(order, ['device']);
  assert.equal(await permissions.check('site.example', 'sign_event'), 'persisted');

  // Second call: no prompt, the device still runs.
  windows.bump();
  const windowsBefore = windows.created;
  await consent({ method: 'sign_event', args: [{ kind: 1 }], sender, requestId: 'r2' });
  await runDevice();
  assert.equal(windows.created, windowsBefore, 'no prompt window opened');
  assert.deepEqual(order, ['device', 'device'], 'the device was still called — the touch is always required');
});

test('US-1701 unchecked remember is this-time-only: the next call prompts again', async () => {
  const { permissions, prompt, consent, windows } = rig();
  windows.bump();
  const gate1 = consent({ method: 'get_public_key', args: [], sender, requestId: 'r1' });
  await answerPrompt(prompt, 'r1', { approve: true, remember: false });
  await gate1;
  assert.equal(await permissions.check('site.example', 'get_public_key'), 'session');

  windows.bump();
  const gate2 = consent({ method: 'get_public_key', args: [], sender, requestId: 'r2' });
  await answerPrompt(prompt, 'r2', { approve: true, remember: false });
  await gate2;
  assert.equal(await permissions.check('site.example', 'get_public_key'), 'session',
    'still not persisted');
});

test('US-1701 revoke → the next call prompts; the grant covers only the approved methods', async () => {
  const { permissions, prompt, consent, windows } = rig();
  windows.bump();
  const g1 = consent({ method: 'sign_event', args: [{ kind: 1 }], sender, requestId: 'r1' });
  await answerPrompt(prompt, 'r1', { approve: true, remember: true });
  await g1;
  assert.deepEqual((await permissions.list()).find((s) => s.host === 'site.example').methods, ['sign_event'],
    'the grant covers exactly the method approved, not the host wholesale');

  await permissions.revoke('site.example');
  windows.bump();
  const g2 = consent({ method: 'sign_event', args: [{ kind: 1 }], sender, requestId: 'r2' });
  await answerPrompt(prompt, 'r2', { approve: true, remember: true });
  await g2;
  assert.equal(windows.created, 2, 'the next call after revocation prompts again');
});

test('US-1701 revoke-all clears every site at once', async () => {
  const { permissions } = rig();
  await permissions.grant('a.example', ['sign_event']);
  await permissions.grant('b.example', ['get_public_key']);
  await permissions.revoke(null);
  assert.deepEqual(await permissions.list(), []);
});

// US-1731 — the Sites screen reads grants in the shared vocabulary, not the
// raw method identifiers. No jsdom here, so the assertion parses popup.js as
// text: the render path imports the shared module and maps g.methods through
// it, and the old raw `g.methods.join` is gone.

test('US-1731 the Sites screen renders grant methods in shared plain words, not identifiers', async () => {
  const src = await readPopup();
  // imports the shared vocabulary module at all
  assert.match(src, /method[- ]?words|METHOD_WORDS/, 'popup consumes the shared vocabulary');
  // loadSites maps the grant's methods through the formatter, not the raw id
  const loadSites = src.slice(src.indexOf('async function loadSites'));
  assert.match(loadSites, /methodWords\(\s*g\.methods\s*\)/,
    'loadSites renders methodWords(g.methods)');
  // the raw snake_case id is no longer dropped straight into the DOM
  const body = loadSites.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(body, /g\.methods\.join\(\s*[',']\s*\)/,
    'no raw g.methods.join in the render');
});

// US-1732 — "Revoke all" is a two-step arm (never a blocking dialog); every
// revoke reports what it did. The arm/disarm/confirm state is exercised here
// directly (it is clock-driven and pure); the popup wiring is parsed as text.

function armer(nowRef = { v: 1000 }, ms = 5000) {
  return createRevokeAllArmer({ now: () => nowRef.v, ms });
}

test('US-1732 arming is two steps: the first arm does not confirm', () => {
  const a = armer();
  assert.equal(a.armed(), false);
  a.arm();
  assert.equal(a.armed(), true);
  // a second interaction inside the window confirms and clears the arm
  assert.equal(a.confirm(), true);
  assert.equal(a.armed(), false);
});

test('US-1732 confirm when not armed fires nothing', () => {
  const a = armer();
  assert.equal(a.confirm(), false);
  assert.equal(a.armed(), false);
});

test('US-1732 confirm past the arm window is rejected and disarms', () => {
  const ref = { v: 1000 };
  const a = armer(ref, 5000);
  a.arm();
  ref.v = 6001; // 5001ms later — beyond the 5000ms window
  assert.equal(a.confirm(), false);
  assert.equal(a.armed(), false);
});

test('US-1732 within the window confirms; disarm clears the arm', () => {
  const ref = { v: 100 };
  const a = armer(ref, 5000);
  a.arm();
  ref.v = 4000; // inside the window
  assert.equal(a.confirm(), true);

  const b = armer({ v: 4000 }, 5000);
  b.arm();
  b.disarm();
  assert.equal(b.confirm(), false, 'a disarmed arm cannot confirm');
});

test('US-1732 the Sites screen arms first, then confirms before touching the worker', async () => {
  const src = await readPopup();
  assert.match(src, /createRevokeAllArmer/, 'popup imports the armer');

  // the whole US-1732 sites block, up to the next section
  const navStart = src.indexOf('// --- nav');
  const block = src.slice(src.indexOf('// US-1732'), navStart > -1 ? navStart : undefined);

  // first click arms and returns — the worker is not reached on the arm path
  assert.match(block, /armRevokeAll\(\)\s*;\s*return;/, 'the arm path returns before any worker call');
  const iArmed = block.indexOf('!revokeAll.armed()');
  const iRevokeAll = block.indexOf("api.call('revoke_all')");
  assert.ok(iArmed > -1 && iRevokeAll > iArmed, 'the armed-check precedes the revoke_all worker call');

  // the second click only revokes once it has confirmed
  assert.match(block, /if\s*\(\s*!revokeAll\.confirm\(\)\s*\)\s*return;/, 'the confirm guard short-circuits before revoke_all');
});

test('US-1732 the armed state disarms on the timeout and on a click elsewhere', async () => {
  const src = await readPopup();
  // timeout path: the countdown calls disarm()
  assert.match(src, /setTimeout\([\s\S]*?revokeAll\.disarm\(\)/, 'the arm countdown disarms');
  // re-click elsewhere: a document-level listener disarms outside the button
  assert.match(src, /document\.addEventListener\(\s*'mousedown'[\s\S]*?disarmRevokeAll\(\)/,
    'a click outside the armed button disarms');
});

test('US-1732 every revoke shows a typed ok notice naming what it revoked', async () => {
  const src = await readPopup();
  // per-host revoke names the host
  assert.match(src, /notice\(\s*`revoked \$\{host\}`\s*,\s*'ok'\s*\)/, 'per-host revoke notices the host');
  // revoke-all names the batch
  assert.match(src, /notice\(\s*'revoked all grants'\s*,\s*'ok'\s*\)/, 'revoke-all notices the batch');
});
