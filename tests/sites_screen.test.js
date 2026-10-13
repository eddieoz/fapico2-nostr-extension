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
