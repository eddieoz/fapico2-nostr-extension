// US-1689 — the build: five esbuild bundles into dist/, plus the manifest,
// pages, styles and icons copied verbatim. dist/ is committed (the OpenXrypt
// vendored-bundle pattern): CI's bundle-freshness gate rebuilds and diffs,
// so a stale dist/ fails the tree instead of shipping stale bytes.
import { build } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');
mkdirSync(dist, { recursive: true });

const common = {
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome116',
  logLevel: 'warning',
  sourcemap: false,
  minify: false,
};

const entries = [
  // The service worker — the device owner.
  { entry: 'src/worker/worker.js', outfile: 'dist/worker.js' },
  // The MAIN-world provider chunk, served via web_accessible_resources and
  // injected by the bridge as a <script src> tag (US-1696).
  { entry: 'src/provider/provider.js', outfile: 'dist/provider.js' },
  // The isolated-world bridge: stateless relay, no device access.
  { entry: 'src/content/bridge.js', outfile: 'dist/bridge.js' },
  // Extension pages.
  { entry: 'src/popup/popup.js', outfile: 'dist/popup.js' },
  // The connect window: the chooser can't anchor to the action popup
  // (it closes on blur and cancels the request), so it runs here.
  { entry: 'src/popup/connect.js', outfile: 'dist/connect.js' },
  { entry: 'src/prompt/prompt.js', outfile: 'dist/prompt.js' },
  // US-1709: the ceremony page's bundle (nostr-tools + the seam over the
  // raw device) — tests/manual/ceremony.html imports it from the repo root.
  { entry: 'src/manual/ceremony-page.js', outfile: 'dist/ceremony.js' },
];

for (const { entry, outfile } of entries) {
  await build({ ...common, entryPoints: [join(root, entry)], outfile });
}

for (const file of ['src/manifest.json', 'src/popup/popup.html', 'src/popup/popup.css', 'src/popup/connect.html', 'src/prompt/prompt.html', 'src/prompt/prompt.css']) {
  cpSync(join(root, file), join(dist, file.split('/').pop()));
}
cpSync(join(root, 'assets/icons'), join(dist, 'icons'), { recursive: true });

console.log('dist/ built: worker.js provider.js bridge.js popup.js prompt.js + manifest, pages, icons');
