// The worker's method table — the closed handler set the dispatch routes
// to. The five page-allowed methods ride the FapicoSigner/FapicoNip44 seams
// over the (single, serialized) device owner; the management methods are
// the popup's key-management surface (US-1702..1706) and the grants store
// (US-1699..1701).
//
// The consent gate for relayed (tab) senders wraps the page-allowed
// handlers: `consent` is provided by the permission store + prompt
// orchestration (US-1699/1700); a trusted extension-page sender skips it.

import { FapicoSigner, FapicoNip44, SwError } from '../core/seams.js';
import { NOSTR_CMD, SW } from '../core/ctaphid.js';
import { DeviceAbsentError } from '../core/loudness.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

export function createHandlers({
  device,
  consent = async ({ method }) => ({ remember: false }),
  previewOf = null,
  listGrants = async () => [],
  revoke = async () => {},
  onPromptDecision = null,
  now = () => Date.now(),
}) {
  const transport = {
    vendor: (cmd, idx, arg, opts = {}) => device.run(cmd, idx, arg, opts),
  };
  const signer = new FapicoSigner(transport);
  const cipher = new FapicoNip44(transport);

  // The page-facing methods: consent first (per-host, per-method), then the
  // device. A trusted extension-page sender (the popup) skips the prompt.
  const pageMethod = (method, fn) => async (args, ctx) => {
    if (!ctx.trusted) {
      await consent({
        method,
        args,
        sender: ctx.sender,
        requestId: ctx.requestId,
        preview: previewOf?.(method, args),
      });
    }
    return fn(args, ctx);
  };

  /** Encode one applet command with a fixed-shape argument; run it through
   *  the serialized device owner and require 9000 (typed SwError
   *  otherwise — the status vocabulary crosses untouched). */
  const runOk = async (cmd, idx, arg) => {
    const { sw, data } = await device.run(cmd, idx, arg);
    if (sw !== SW.OK) throw new SwError(cmdName(cmd), sw);
    return data;
  };
  const cmdName = (cmd) =>
    Object.entries(NOSTR_CMD).find(([, v]) => v === cmd)?.[0] ?? `0x${cmd.toString(16)}`;

  return {
    // --- trusted-only (extension pages) -----------------------------------
    echo: async (args) => ({ echoed: args }),

    device_status: async () => {
      try {
        const res = await device.ping();
        return { state: res.sw === SW.OK ? 'connected' : 'error', sw: res.sw };
      } catch (err) {
        if (err instanceof DeviceAbsentError || err?.code === 'DEVICE_ABSENT') {
          return { state: 'absent', code: 'DEVICE_ABSENT' };
        }
        return { state: 'error', code: err.code ?? 'error', message: err.message };
      }
    },

    // US-1702: the popup drives the chooser itself (a user gesture), then
    // tells the worker to adopt the granted device — the worker still never
    // opens a chooser.
    pair_device: async () => {
      device.forget();
      const res = await device.ping();
      return { state: res.sw === SW.OK ? 'connected' : 'error', sw: res.sw };
    },

    generate_key: async ([slot]) => {
      if (!Number.isInteger(slot) || slot < 0 || slot > 7) {
        throw Object.assign(new Error('slot must be 0..7'), { name: 'SignerError', code: 'BAD_SLOT' });
      }
      const data = await runOk(NOSTR_CMD.GENERATE_KEY, slot, new Uint8Array(0));
      if (data.length < 32) {
        throw Object.assign(new Error('GENERATE_KEY answered 9000 with a short npub'), {
          name: 'SignerError', code: 'DEVICE_REPLY_MALFORMED',
        });
      }
      return { npub: bytesToHex(data.subarray(0, 32)) };
    },

    import_key: async ([slot, scalarHex]) => {
      if (!Number.isInteger(slot) || slot < 0 || slot > 7) {
        throw Object.assign(new Error('slot must be 0..7'), { name: 'SignerError', code: 'BAD_SLOT' });
      }
      const scalar = hexToBytes(scalarHex);
      if (scalar.length !== 32) {
        throw Object.assign(new Error('the scalar must be 32 bytes'), { name: 'SignerError', code: 'BAD_SCALAR' });
      }
      const data = await runOk(NOSTR_CMD.IMPORT_KEY, slot, scalar);
      if (data.length < 32) {
        throw Object.assign(new Error('IMPORT_KEY answered 9000 with a short npub'), {
          name: 'SignerError', code: 'DEVICE_REPLY_MALFORMED',
        });
      }
      return { npub: bytesToHex(data.subarray(0, 32)) };
    },

    delete_key: async ([slot, expectedNpub]) => {
      if (!Number.isInteger(slot) || slot < 0 || slot > 7) {
        throw Object.assign(new Error('slot must be 0..7'), { name: 'SignerError', code: 'BAD_SLOT' });
      }
      const data = await runOk(NOSTR_CMD.DELETE_KEY, slot, new Uint8Array(0));
      if (data.length < 32) {
        throw Object.assign(new Error('DELETE_KEY answered 9000 without the echoed npub'), {
          name: 'SignerError', code: 'DEVICE_REPLY_MALFORMED',
        });
      }
      // US-1706: the echo must name the slot that was asked to die — a
      // mismatch is a typed store-fault, never a green checkmark.
      const echoed = bytesToHex(data.subarray(0, 32));
      if (expectedNpub && echoed !== expectedNpub) {
        throw Object.assign(
          new Error(`the device echoed a different identity than the one requested — store fault, not success`),
          { name: 'SignerError', code: 'STORE_FAULT' },
        );
      }
      return { npub: echoed };
    },

    set_label: async ([slot, label]) => {
      if (!Number.isInteger(slot) || slot < 0 || slot > 7) {
        throw Object.assign(new Error('slot must be 0..7'), { name: 'SignerError', code: 'BAD_SLOT' });
      }
      const bytes = new TextEncoder().encode(label);
      if (bytes.length > 32) {
        throw Object.assign(new Error(`label is ${bytes.length} bytes — the device takes at most 32`), {
          name: 'SignerError', code: 'LABEL_TOO_LONG',
        });
      }
      await runOk(NOSTR_CMD.SET_LABEL, slot, bytes);
      return {};
    },

    export_key: async ([slot]) => {
      if (!Number.isInteger(slot) || slot < 0 || slot > 7) {
        throw Object.assign(new Error('slot must be 0..7'), { name: 'SignerError', code: 'BAD_SLOT' });
      }
      const data = await runOk(NOSTR_CMD.EXPORT_KEY, slot, new Uint8Array(0));
      if (data.length < 32) {
        throw Object.assign(new Error('EXPORT_KEY answered 9000 without a scalar'), {
          name: 'SignerError', code: 'DEVICE_REPLY_MALFORMED',
        });
      }
      return { scalar: bytesToHex(data.subarray(0, 32)) };
    },

    get_grants: async () => listGrants(),
    revoke_grant: async ([host]) => revoke(host),
    revoke_all: async () => revoke(null),

    prompt_decision: onPromptDecision ?? (async () => ({})),

    // --- page-allowed (relayed; consent-gated for tab senders) -------------
    get_public_key: pageMethod('get_public_key', async ([idx = 0]) =>
      bytesToHex(await runOk(NOSTR_CMD.GET_PUBKEY, idx, new Uint8Array(0)).then((d) => {
        if (d.length < 32) {
          throw Object.assign(new Error('GET_PUBKEY answered 9000 with a short npub'), {
            name: 'SignerError', code: 'DEVICE_REPLY_MALFORMED',
          });
        }
        return d.subarray(0, 32);
      }))),

    sign_event: pageMethod('sign_event', async ([event]) => signer.signEvent(event)),

    list_keys: pageMethod('list_keys', async () => signer.listKeys()),

    nip44_encrypt: pageMethod('nip44_encrypt', async ([peer, plaintext]) =>
      [...(await cipher.encrypt(peer, hexToBytes(plaintext)))]),

    nip44_decrypt: pageMethod('nip44_decrypt', async ([peer, payload]) =>
      [...(await cipher.decrypt(peer, new Uint8Array(payload)))]),
  };
}
