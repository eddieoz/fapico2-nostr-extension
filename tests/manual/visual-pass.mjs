// US-1740 — the DevTools layout pass. Launches a real Chrome (the US-1708
// smoke-gate recipe: --enable-unsafe-extension-debugging +
// --remote-debugging-port), loads the built dist/ via CDP
// Extensions.loadUnpacked, opens the three extension pages in scripted
// journey states through a chrome.* stub, and captures screenshots into
// docs/visual/us-1740/ — the before/after record the story's acceptance
// asks for. Manual tooling, like the ceremony page: skipped cleanly when
// CHROME_PATH is unset, never part of npm test.

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { wsConnect } from '../smoke/ws.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const dist = join(root, 'dist');
const outDir = join(root, 'docs', 'visual', 'us-1740', process.argv[2] ?? 'after');

const KEY_A = '0addad3acd0ea076ba98f7f778cf7c875363fab9b5f98cce7f44a2a02c47fb30';
const KEY_B = 'bf2d3c9d70c37f2d7e46b24a1c0fd8e3a51c99b4d8e6f0a1b2c3d4e5f6071829';
const KEY_C = '5c1e8f2a6b7c8d9e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f70';
const GRANT_DATE = 1760284800000; // 2025-10-12, the audit's date

/** The chrome.* stub, serialized into the page before its own scripts run.
 *  `scenario.calls` maps method -> RESULT VALUE (JSON-serializable; no
 *  functions survive the new-document injection). A value of
 *  `{ __error: {...} }` answers as a typed error instead. */
const STUB_SOURCE = String(function install(scenario) {
  const listeners = [];
  const port = {
    onMessage: { addListener: (fn) => listeners.push(fn) },
    onDisconnect: { addListener: () => {} },
    postMessage(frame) {
      if (typeof frame.id === 'undefined') return; // a push frame has no caller here
      const table = scenario.calls ?? {};
      const v = table[frame.method];
      // Microtask reply: the whole state machine (boot + drive) settles
      // within one task, so the target state exists before the page's first
      // paint — the one paint this environment reliably produces.
      queueMicrotask(() => {
        const reply =
          v === undefined
            ? { id: frame.id, error: { name: 'UnsupportedMethodError', code: 'unsupported-method', message: `${frame.method} is not stubbed` } }
            : v && v.__error
              ? { id: frame.id, error: v.__error }
              : { id: frame.id, result: v };
        for (const l of [...listeners]) l(reply);
      });
    },
  };
  window.__pushFrame = (frame) => {
    for (const l of [...listeners]) l(frame);
  };
  if (scenario.hid) {
    // navigator.hid is an accessor without a setter — defineProperty is the
    // only way in, and the stubbed chooser skips the gesture check the real
    // requestDevice enforces.
    Object.defineProperty(navigator, 'hid', { value: { requestDevice: async () => scenario.hid }, configurable: true });
  }
  window.chrome = {
    runtime: {
      id: 'visual',
      connect: () => port,
      getURL: (p) => `chrome-extension://visual${p}`,
    },
    storage: {
      session: { get: async () => scenario.session ?? {}, set: async () => {} },
      local: { get: async () => ({}), set: async () => {} },
    },
    tabs: { create: async () => {}, getCurrent: (cb) => cb(null) },
  };
}).toString();

const KEYS = [
  { idx: 0, pubkey: KEY_A, flags: 1, label: 'main' },
  { idx: 1, pubkey: KEY_B, flags: 1, label: '' },
  { idx: 3, pubkey: KEY_C, flags: 1, label: 'burner' },
];
const GRANTS = [
  { host: 'snort.social', methods: ['get_public_key', 'sign_event'], grantedAt: GRANT_DATE },
  { host: 'njump.me', methods: ['get_public_key'], grantedAt: GRANT_DATE },
];
const connectedCalls = () => ({
  device_status: { state: 'connected', sw: 36864 },
  list_keys: KEYS,
  get_active_slot: { slot: 1 },
  get_grants: GRANTS,
  prompt_decision: { delivered: true },
});
const absentCalls = () => ({
  device_status: { state: 'absent', code: 'DEVICE_ABSENT' },
  list_keys: { __error: { name: 'DeviceAbsentError', code: 'DEVICE_ABSENT', message: 'no fapico2 board granted' } },
  get_active_slot: { slot: 0 },
});

// Each shot: name, page URL, viewport, the scenario the stub serves, and an
// optional `autorun` — in-page JS the stub executes in a setTimeout(0) task
// after DOMContentLoaded, BEFORE the page's first paint (the microtask-replied
// stub settles every chain inside that task), so the one reliable paint shows
// the target state.
const SHOTS = [
  {
    name: '01-popup-keys-home',
    page: 'popup.html',
    width: 360, height: 600,
    scenario: { session: { nostrDeviceCard: { state: 'connected' } }, calls: connectedCalls() },
  },
  {
    name: '02-popup-connect-first',
    page: 'popup.html',
    width: 360, height: 600,
    scenario: { session: {}, calls: absentCalls() },
  },
  {
    name: '03-popup-generate',
    page: 'popup.html',
    width: 360, height: 600,
    scenario: {
      session: { nostrDeviceCard: { state: 'connected' } }, calls: connectedCalls(),
      autorun: `document.getElementById('go-generate').click()`,
    },
  },
  {
    name: '04-popup-delete-confirm',
    page: 'popup.html',
    width: 360, height: 600,
    scenario: {
      session: { nostrDeviceCard: { state: 'connected' } }, calls: connectedCalls(),
      autorun: `document.querySelector('button[data-act="delete"]').click()`,
    },
  },
  {
    name: '05-popup-sites',
    page: 'popup.html',
    width: 360, height: 600,
    scenario: {
      session: { nostrDeviceCard: { state: 'connected' } }, calls: connectedCalls(),
      autorun: `document.getElementById('nav-sites').click()`,
    },
  },
  {
    name: '06-connect-idle',
    page: 'connect.html',
    width: 1280, height: 800,
    scenario: { session: {}, calls: absentCalls() },
  },
  {
    name: '07-connect-handoff',
    page: 'connect.html',
    width: 1280, height: 800,
    scenario: {
      session: {},
      hid: [{}],
      calls: {
        device_status: { state: 'absent', code: 'DEVICE_ABSENT' },
        pair_device: { state: 'connected', sw: 36864 },
        list_keys: [],
      },
      // The handoff is a CONNECT-CLICK outcome (US-1714), never a boot state —
      // drive the real click: the chooser resolves through the stubbed
      // navigator.hid, pair_device reports connected, list_keys answers zero,
      // and the page renders the toolbar handoff and stays open.
      autorun: `document.getElementById('connect').click()`,
    },
  },
  {
    name: '08-prompt-request',
    page: `prompt.html?request=r1&method=sign_event&host=snort.social&preview=${encodeURIComponent('signs a short text note — "gm nostr, the board signs and nobody asks twice"')}`,
    width: 420, height: 340,
    scenario: { session: {}, calls: { get_active_slot: { slot: 1 }, list_keys: KEYS } },
  },
  {
    name: '09-prompt-touch-state',
    page: `prompt.html?request=r1&method=sign_event&host=snort.social&preview=${encodeURIComponent('signs a short text note — "gm nostr"')}`,
    width: 420, height: 340,
    scenario: {
      session: {}, calls: { get_active_slot: { slot: 1 }, list_keys: KEYS, prompt_decision: { delivered: true } },
      autorun: `document.getElementById('approve').click()`,
    },
  },
  {
    name: '10-prompt-touch-timeout',
    page: `prompt.html?request=r1&method=sign_event&host=snort.social&preview=${encodeURIComponent('signs a short text note — "gm nostr"')}`,
    width: 420, height: 340,
    scenario: {
      session: {}, calls: { get_active_slot: { slot: 1 }, list_keys: KEYS, prompt_decision: { delivered: true } },
      // Approve + settle in the one task; window.close is neutralized because
      // the page's 800ms self-close backstop (US-1724) would otherwise kill
      // the target under the capture.
      autorun: `window.close = () => {}; document.getElementById('approve').click(); queueMicrotask(() => queueMicrotask(() => window.__pushFrame({ event: 'prompt-settled', requestId: 'r1', outcome: 'err', message: 'the touch timed out — the device was not pressed in time' })))`,
    },
  },
  {
    name: '11-prompt-signed-beat',
    page: `prompt.html?request=r1&method=sign_event&host=snort.social&preview=${encodeURIComponent('signs a short text note — "gm nostr"')}`,
    width: 420, height: 340,
    scenario: {
      session: {}, calls: { get_active_slot: { slot: 1 }, list_keys: KEYS, prompt_decision: { delivered: true } },
      autorun: `window.close = () => {}; document.getElementById('approve').click(); queueMicrotask(() => queueMicrotask(() => window.__pushFrame({ event: 'prompt-settled', requestId: 'r1', outcome: 'ok' })))`,
    },
  },
];

function launchChrome() {
  const profile = mkdtempSync(join(tmpdir(), 'fapico-visual-'));
  // HEADED, not headless: the headless=new compositor never repaints after
  // CDP-driven DOM mutations (every capture source — captureScreenshot,
  // screencast, bringToFront — returns the load-time frame), so post-load
  // states would screenshot stale. Under xvfb-run a real compositor paints
  // for real; Extensions.loadUnpacked works headed with the same flag.
  // Run: xvfb-run -a env CHROME_PATH=google-chrome node tests/manual/visual-pass.mjs [before|after]
//   (the shot-set directory under docs/visual/us-1740/, default `after`)
//
// KNOWN LIMITATION (Chrome 154 under xvfb): the browser compositor serves
// stale main-thread frames after the page's first paint — a post-load DOM
// change can be verified in the DOM (the per-shot probe below) but never
// rasterized: captureScreenshot, screencast and fromSurface:false all return
// the load-time frame (or a mix of fresh and stale tiles). The driven states
// therefore run PRE-PAINT (the stub replies on microtasks; the shot's
// `autorun` executes in a setTimeout(0) task after DOMContentLoaded, before
// any render step), so the one reliable paint shows the target state. Only
// the prompt page's post-approve beats resist even that in practice; their
// geometry is verified via the DOM probe and shot 09's bar placement.
  const args = [
    '--enable-unsafe-extension-debugging',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ];
  const child = spawn(process.env.CHROME_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const wsUrl = new Promise((resolve, reject) => {
    let acc = '';
    const timer = setTimeout(() => reject(new Error('chrome never printed a DevTools endpoint')), 20_000);
    const onData = (d) => {
      acc += d.toString();
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(acc);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    };
    child.stderr.on('data', onData);
    child.stdout.on('data', onData);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`chrome exited early (${code}):\n${acc}`)); });
  });
  return { child, profile, wsUrl };
}

function cdp(ws) {
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (msg) => {
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
      else resolve(msg.result);
    }
  };
  return {
    send(method, params = {}, sessionId) {
      const id = ++seq;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send({ id, method, params, ...(sessionId ? { sessionId } : {}) });
      });
    },
  };
}

async function main() {
  if (!process.env.CHROME_PATH) {
    console.log('visual: skipped — CHROME_PATH unset');
    return;
  }
  mkdirSync(outDir, { recursive: true });
  const { child, profile, wsUrl } = await launchChrome();
  const ws = await wsConnect(await wsUrl, { timeoutMs: 15_000 });
  const c = cdp(ws);
  try {
    const { id: extensionId } = await c.send('Extensions.loadUnpacked', { path: dist });
    console.log(`visual: extension loaded (${extensionId})`);

    for (const shot of SHOTS.filter((s) => !process.env.SHOT || s.name.includes(process.env.SHOT))) {
      const { targetId } = await c.send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await c.send('Target.attachToTarget', { targetId, flatten: true });
      await c.send('Page.enable', {}, sessionId);
      await c.send('Runtime.enable', {}, sessionId);
      await c.send('Emulation.setDeviceMetricsOverride', { width: shot.width, height: shot.height, deviceScaleFactor: 2, mobile: false }, sessionId);
      // The stub call plus, for driven shots, the autorun INLINED — a new
      // Function(...) inside the page would be eval, and MV3's CSP refuses
      // it; the DevTools-injected document-start script is exempt.
      const autorun = shot.scenario.autorun
        ? `document.addEventListener('DOMContentLoaded', () => { setTimeout(() => { ${shot.scenario.autorun}; }, 0); });`
        : '';
      await c.send(
        'Page.addScriptToEvaluateOnNewDocument',
        { source: `(${STUB_SOURCE})(${JSON.stringify({ ...shot.scenario, autorun: undefined })});${autorun}` },
        sessionId,
      );
      await c.send('Page.navigate', { url: `chrome-extension://${extensionId}/${shot.page}` }, sessionId);
      await new Promise((r) => setTimeout(r, 500)); // the boot + autorun settle pre-paint; this is just courtesy
      const evalJs = async (expression, label) => {
        const res = await c.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
        if (res.exceptionDetails) {
          throw new Error(`${label} failed: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`);
        }
        return res.result.value;
      };
      const dom = await evalJs(
        `JSON.stringify({ touch: document.getElementById('touch-bar')?.hidden, outcome: document.getElementById('outcome')?.textContent ?? null, notice: document.getElementById('notice')?.textContent ?? null })`,
        `dom (${shot.name})`,
      );
      console.log(`visual: ${shot.name} dom ${dom}`);
      // The autorun ran pre-paint, so any frame — including the capture's —
      // shows the target state. The double-rAF just guarantees a commit exists.
      await evalJs(
        'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 50))))',
        `flush (${shot.name})`,
      );
      const { data } = await c.send('Page.captureScreenshot', { format: 'png' }, sessionId);
      const file = join(outDir, `${shot.name}.png`);
      writeFileSync(file, Buffer.from(data, 'base64'));
      console.log(`visual: ${shot.name} -> ${file}`);
      await c.send('Target.closeTarget', { targetId });
    }
  } finally {
    ws.close();
    child.kill();
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* the profile dies with the tmp dir anyway */
    }
  }
}

main().catch((err) => {
  console.error(`visual: FAIL — ${err.message}`);
  process.exit(1);
});
