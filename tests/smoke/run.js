// US-1708 — the CDP smoke gate: the test that would have caught the
// OpenXrypt P0. Launches a real Chrome with
// --enable-unsafe-extension-debugging --remote-debugging-port, loads the
// built dist/ via CDP Extensions.loadUnpacked, opens a local test page, and
// asserts on the live MAIN world:
//   1. typeof window.nostr === 'object'
//   2. the surface is exactly the five methods (NIP-07 trio + nip44)
//   3. getPublicKey() with no device grant rejects DeviceAbsentError —
//      typed and loud, not a hang, not undefined
//
// Runs in CI (CHROME_PATH set) and locally when Chrome is available; the
// flag gate skips cleanly when CHROME_PATH is unset. A failure is a release
// blocker. Plain Node + CDP over WebSocket — no Playwright, no ws dep.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { wsConnect } from './ws.js';
import { manifestTripwire } from './checks.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const dist = join(root, 'dist');

const PAGE_HTML = `<!doctype html><html><head><title>smoke</title></head>
<body>smoke target</body></html>`;

function fail(msg) {
  console.error(`smoke: FAIL — ${msg}`);
  process.exit(1);
}

async function startPageServer() {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE_HTML);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
}

async function launchChrome() {
  const profile = mkdtempSync(join(tmpdir(), 'fapico-smoke-'));
  const args = [
    '--headless=new',
    '--enable-unsafe-extension-debugging',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    'about:blank',
  ];
  const child = spawn(process.env.CHROME_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const wsUrl = await new Promise((resolve, reject) => {
    let acc = '';
    const timer = setTimeout(() => reject(new Error('chrome never printed a DevTools endpoint')), 20_000);
    const onData = (d) => {
      acc += d.toString();
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(acc);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    };
    child.stderr.on('data', onData);
    child.stdout.on('data', onData);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`chrome exited early (${code}):\n${acc}`));
    });
  });
  return { child, profile, wsUrl };
}

/** A CDP client over the browser WebSocket: id-matched commands. */
function cdp(ws) {
  let seq = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (msg) => {
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
      else resolve(msg.result);
    } else if (msg.method) {
      for (const fn of listeners) fn(msg);
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
    onEvent: (fn) => listeners.push(fn),
  };
}

async function main() {
  if (!process.env.CHROME_PATH) {
    console.log('smoke: skipped — CHROME_PATH unset');
    return;
  }

  // The tripwire runs regardless of the live gate: the manifest shape that
  // kills NIP-07 (world: MAIN with a duplicate file) must be detected.
  const tripwire = manifestTripwire(JSON.parse((await import('node:fs')).readFileSync(join(root, 'src', 'manifest.json'), 'utf8')));
  if (tripwire) fail(`the manifest trips the OpenXrypt P0 shape: ${tripwire}`);

  const { server, url } = await startPageServer();
  const { child, profile, wsUrl } = await launchChrome();
  try {
    const ws = await wsConnect(wsUrl, { timeoutMs: 15_000 });
    const c = cdp(ws);

    // Load the built extension.
    await c.send('Extensions.loadUnpacked', { path: dist });
    console.log('smoke: extension loaded from dist/');

    // Open the test page and wait for the content script to run.
    const { targetId } = await c.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await c.send('Target.attachToTarget', { targetId, flatten: true });
    await c.send('Page.enable', {}, sessionId);
    await c.send('Page.navigate', { url }, sessionId);
    // The provider installs at document_start; give the bridge a beat.
    await new Promise((r) => setTimeout(r, 800));

    const evalJs = async (expression) => {
      const res = await c.send(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true },
        sessionId,
      );
      if (res.exceptionDetails) {
        throw new Error(`page eval failed: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`);
      }
      return res.result.value;
    };

    // 1. The provider exists in the MAIN world.
    const type = await evalJs('typeof window.nostr');
    if (type !== 'object') fail(`window.nostr is ${type} — the P0 lives here`);
    console.log('smoke: window.nostr is an object in the MAIN world');

    // 2. The surface is exactly the five methods.
    const surface = await evalJs(
      `(() => { const k = Object.keys(window.nostr).sort();
         return { top: k, nip44: window.nostr.nip44 ? Object.keys(window.nostr.nip44).sort() : null }; })()`,
    );
    const wantTop = JSON.stringify(['getPublicKey', 'listKeys', 'nip44', 'signEvent']);
    if (JSON.stringify(surface.top) !== wantTop) {
      fail(`surface is ${JSON.stringify(surface.top)} — expected ${wantTop}`);
    }
    if (JSON.stringify(surface.nip44) !== JSON.stringify(['decrypt', 'encrypt'])) {
      fail(`nip44 surface is ${JSON.stringify(surface.nip44)}`);
    }
    console.log('smoke: the surface is exactly the NIP-07 trio + nip44');

    // 3. No device grant: the typed, loud refusal — not a hang, not undefined.
    const rejection = await evalJs(
      `window.nostr.getPublicKey().then(
         () => ({ resolved: true }),
         (e) => ({ resolved: false, name: e.name, code: e.code, message: e.message }),
       )`,
    );
    if (rejection.resolved !== false) fail('getPublicKey resolved without a device — silent fallback?');
    if (rejection.name !== 'DeviceAbsentError' || rejection.code !== 'DEVICE_ABSENT') {
      fail(`expected DeviceAbsentError/DEVICE_ABSENT, got ${rejection.name}/${rejection.code}`);
    }
    console.log('smoke: getPublicKey without a grant rejects DeviceAbsentError (typed, loud)');

    console.log('smoke: PASS');
    ws.close();
  } finally {
    child.kill('SIGKILL');
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch { /* windows/file locks — the tmpdir cleans itself */ }
    server.close();
  }
}

main().catch((err) => fail(err.message));
