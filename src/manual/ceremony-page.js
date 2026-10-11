// US-1709 — the browser wrapper of the hardware ceremony. The page is the
// manual release gate: a human runs it against a flashed fapico2 feat/nostr
// board, steps block on failure, and the results copy into the release
// notes. Serve the repo root over any static server and open
// tests/manual/ceremony.html.

import { CtapVendorTransport, requestDevice } from '../core/ctaphid.js';
import { FapicoSigner, FapicoNip44 } from '../core/seams.js';
import { getEventHash, verifyEvent } from 'nostr-tools';
import { schnorr } from '@noble/curves/secp256k1.js';
import { hexToBytes } from '@noble/hashes/utils.js';
import { createCeremony } from './ceremony-steps.js';

const $ = (id) => document.getElementById(id);
const logLine = (html) => {
  $('log').innerHTML += html + '\n';
  $('log').scrollTop = $('log').scrollHeight;
};

let ceremony = null;

// The vendor interface is usage page 0xFF00, usage 0x01 (the contract the
// extension filters on). getDevices-first: a grant from an earlier run in
// this profile reuses the device with no chooser; the chooser is the only
// other path, and it needs the user's click.
async function findVendorDevice() {
  const known = await navigator.hid.getDevices();
  return (
    known.find((d) => d.collections?.some((c) => c.usagePage === 0xff00 && c.usage === 0x01)) ??
    null
  );
}

$('start').addEventListener('click', async () => {
  try {
    if (!navigator.hid) {
      logLine('<span class="err">WebHID is not available in this browser</span>');
      return;
    }
    let dev = await findVendorDevice();
    if (!dev) {
      const chosen = await requestDevice();
      dev = chosen;
    }
    if (!dev) {
      logLine('<span class="err">no Nostr interface (0xFF00:0x01) on the board — is the feat/nostr firmware flashed?</span>');
      return;
    }
    const transport = new CtapVendorTransport(dev);
    const signer = new FapicoSigner(transport);
    const nip = new FapicoNip44(transport);
    ceremony = createCeremony({
      transport,
      dev,
      signer,
      nip,
      crypto: {
        sighashOf: (event, pubkey) =>
          hexToBytes(getEventHash({ ...event, pubkey })),
        verifyEvent: (signed) => verifyEvent(signed),
        schnorrVerify: (sig, msgHash, pub) =>
          schnorr.verify(hexToBytes(sig), msgHash, hexToBytes(pub)),
        // The round trip through the device: encrypt, then decrypt, and the
        // plaintext must come back byte-exact.
        nip44RoundTrip: async (nipImpl, peer, plaintext) => {
          const payload = await nipImpl.encrypt(peer, plaintext);
          const round = await nipImpl.decrypt(peer, payload);
          return round.every((b, i) => b === plaintext[i]) && round.length === plaintext.length
            ? { ok: true, detail: `round trip ok (${plaintext.length} bytes)` }
            : { ok: false, detail: 'the decrypted plaintext did not match' };
        },
      },
      log: (step, ok, detail) => {
        logLine(
          `<span class="${ok ? 'ok' : 'err'}">${ok ? 'PASS' : 'FAIL'} ${step}</span>` +
            ` <span class="dim">${JSON.stringify(detail)}</span>`,
        );
      },
    });
    logLine('ceremony armed — run the steps in order');
    $('next').disabled = false;
  } catch (err) {
    logLine(`<span class="err">device open failed: ${err.message}</span>`);
  }
});

$('next').addEventListener('click', async () => {
  if (!ceremony) return;
  $('next').disabled = true;
  const out = await ceremony.runNext();
  if (out.blocked) {
    logLine(`<span class="err">ceremony blocked${out.step ? ` at ${out.step}` : ''} — fix and restart</span>`);
    if (out.done) {
      logLine('<span class="ok">ceremony COMPLETE — copy the results into the release notes</span>');
      $('results').textContent = JSON.stringify(ceremony.results, null, 2);
    }
    return;
  }
  $('next').disabled = !ceremony.nextStep;
  if (!ceremony.nextStep) {
    logLine('<span class="ok">ceremony COMPLETE — copy the results into the release notes</span>');
    $('results').textContent = JSON.stringify(ceremony.results, null, 2);
  }
});
