(() => {
  // src/shared/port-client.js
  var STALE_MS = 2e4;
  var HEARTBEAT_MS = 2e4;
  function createPortClient({ chrome_ = chrome, name = null, now = Date.now, heartbeatMs = HEARTBEAT_MS } = {}) {
    const portName = name ?? `nostr-page-${Math.floor(Math.random() * 1e9).toString(36)}`;
    let seq = 0;
    const pending = /* @__PURE__ */ new Map();
    const eventFns = /* @__PURE__ */ new Set();
    const disconnectFns = /* @__PURE__ */ new Set();
    let port = connect();
    let lastSeen = now();
    function connect() {
      const p = chrome_.runtime.connect({ name: portName });
      p.onMessage.addListener(handle);
      p.onDisconnect.addListener(() => {
        if (port === p) port = null;
        for (const fn of [...disconnectFns]) fn();
      });
      return p;
    }
    function handle(msg) {
      if (!msg) return;
      lastSeen = now();
      if (typeof msg.id !== "undefined") {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        if (msg.error) {
          const err = new Error(msg.error.message);
          err.name = msg.error.name;
          err.code = msg.error.code;
          if (msg.error.sw !== void 0) err.sw = msg.error.sw;
          if (msg.error.device !== void 0) err.device = msg.error.device;
          p.reject(err);
        } else {
          p.resolve(msg.result);
        }
        return;
      }
      for (const fn of [...eventFns]) fn(msg);
    }
    function send(frame) {
      if (!port || now() - lastSeen > STALE_MS) {
        port = connect();
      }
      try {
        port.postMessage(frame);
      } catch {
        port = connect();
        port.postMessage(frame);
      }
    }
    let heartbeatTimer = null;
    function call(method2, ...args) {
      return new Promise((resolve, reject) => {
        const id = `c${seq++}`;
        pending.set(id, { resolve, reject });
        try {
          send({ id, method: method2, args });
        } catch {
          pending.delete(id);
          const err = new Error("the connection to the extension was lost \u2014 try again");
          err.name = "TransportError";
          err.code = "transport-lost";
          reject(err);
        }
      });
    }
    if (heartbeatMs > 0) {
      heartbeatTimer = setInterval(() => {
        call("echo").catch(() => {
        });
      }, heartbeatMs);
    }
    return {
      portName,
      /** US-1745 — stops the heartbeat (tests; pages die naturally). */
      dispose() {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      },
      call,
      // US-1721 — subscribe to worker push frames ({event, ...}, no id). Returns
      // an unsubscribe fn.
      onEvent(fn) {
        eventFns.add(fn);
        return () => {
          eventFns.delete(fn);
        };
      },
      // US-1721 — subscribe to port disconnect. Returns an unsubscribe fn.
      onDisconnect(fn) {
        disconnectFns.add(fn);
        return () => {
          disconnectFns.delete(fn);
        };
      }
    };
  }

  // node_modules/.pnpm/@noble+hashes@1.8.0/node_modules/@noble/hashes/esm/utils.js
  var hasHexBuiltin = /* @__PURE__ */ (() => (
    // @ts-ignore
    typeof Uint8Array.from([]).toHex === "function" && typeof Uint8Array.fromHex === "function"
  ))();
  var asciis = { _0: 48, _9: 57, A: 65, F: 70, a: 97, f: 102 };
  function asciiToBase16(ch) {
    if (ch >= asciis._0 && ch <= asciis._9)
      return ch - asciis._0;
    if (ch >= asciis.A && ch <= asciis.F)
      return ch - (asciis.A - 10);
    if (ch >= asciis.a && ch <= asciis.f)
      return ch - (asciis.a - 10);
    return;
  }
  function hexToBytes(hex) {
    if (typeof hex !== "string")
      throw new Error("hex string expected, got " + typeof hex);
    if (hasHexBuiltin)
      return Uint8Array.fromHex(hex);
    const hl = hex.length;
    const al = hl / 2;
    if (hl % 2)
      throw new Error("hex string expected, got unpadded hex of length " + hl);
    const array = new Uint8Array(al);
    for (let ai = 0, hi = 0; ai < al; ai++, hi += 2) {
      const n1 = asciiToBase16(hex.charCodeAt(hi));
      const n2 = asciiToBase16(hex.charCodeAt(hi + 1));
      if (n1 === void 0 || n2 === void 0) {
        const char = hex[hi] + hex[hi + 1];
        throw new Error('hex string expected, got non-hex character "' + char + '" at index ' + hi);
      }
      array[ai] = n1 * 16 + n2;
    }
    return array;
  }

  // node_modules/.pnpm/@scure+base@1.2.6/node_modules/@scure/base/lib/esm/index.js
  function isBytes(a) {
    return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array";
  }
  function isArrayOf(isString, arr) {
    if (!Array.isArray(arr))
      return false;
    if (arr.length === 0)
      return true;
    if (isString) {
      return arr.every((item) => typeof item === "string");
    } else {
      return arr.every((item) => Number.isSafeInteger(item));
    }
  }
  function afn(input) {
    if (typeof input !== "function")
      throw new Error("function expected");
    return true;
  }
  function astr(label, input) {
    if (typeof input !== "string")
      throw new Error(`${label}: string expected`);
    return true;
  }
  function anumber(n) {
    if (!Number.isSafeInteger(n))
      throw new Error(`invalid integer: ${n}`);
  }
  function aArr(input) {
    if (!Array.isArray(input))
      throw new Error("array expected");
  }
  function astrArr(label, input) {
    if (!isArrayOf(true, input))
      throw new Error(`${label}: array of strings expected`);
  }
  function anumArr(label, input) {
    if (!isArrayOf(false, input))
      throw new Error(`${label}: array of numbers expected`);
  }
  // @__NO_SIDE_EFFECTS__
  function chain(...args) {
    const id = (a) => a;
    const wrap = (a, b) => (c) => a(b(c));
    const encode = args.map((x) => x.encode).reduceRight(wrap, id);
    const decode = args.map((x) => x.decode).reduce(wrap, id);
    return { encode, decode };
  }
  // @__NO_SIDE_EFFECTS__
  function alphabet(letters) {
    const lettersA = typeof letters === "string" ? letters.split("") : letters;
    const len = lettersA.length;
    astrArr("alphabet", lettersA);
    const indexes = new Map(lettersA.map((l, i) => [l, i]));
    return {
      encode: (digits) => {
        aArr(digits);
        return digits.map((i) => {
          if (!Number.isSafeInteger(i) || i < 0 || i >= len)
            throw new Error(`alphabet.encode: digit index outside alphabet "${i}". Allowed: ${letters}`);
          return lettersA[i];
        });
      },
      decode: (input) => {
        aArr(input);
        return input.map((letter) => {
          astr("alphabet.decode", letter);
          const i = indexes.get(letter);
          if (i === void 0)
            throw new Error(`Unknown letter: "${letter}". Allowed: ${letters}`);
          return i;
        });
      }
    };
  }
  // @__NO_SIDE_EFFECTS__
  function join(separator = "") {
    astr("join", separator);
    return {
      encode: (from) => {
        astrArr("join.decode", from);
        return from.join(separator);
      },
      decode: (to) => {
        astr("join.decode", to);
        return to.split(separator);
      }
    };
  }
  var gcd = (a, b) => b === 0 ? a : gcd(b, a % b);
  var radix2carry = /* @__NO_SIDE_EFFECTS__ */ (from, to) => from + (to - gcd(from, to));
  var powers = /* @__PURE__ */ (() => {
    let res = [];
    for (let i = 0; i < 40; i++)
      res.push(2 ** i);
    return res;
  })();
  function convertRadix2(data, from, to, padding) {
    aArr(data);
    if (from <= 0 || from > 32)
      throw new Error(`convertRadix2: wrong from=${from}`);
    if (to <= 0 || to > 32)
      throw new Error(`convertRadix2: wrong to=${to}`);
    if (/* @__PURE__ */ radix2carry(from, to) > 32) {
      throw new Error(`convertRadix2: carry overflow from=${from} to=${to} carryBits=${/* @__PURE__ */ radix2carry(from, to)}`);
    }
    let carry = 0;
    let pos = 0;
    const max = powers[from];
    const mask = powers[to] - 1;
    const res = [];
    for (const n of data) {
      anumber(n);
      if (n >= max)
        throw new Error(`convertRadix2: invalid data word=${n} from=${from}`);
      carry = carry << from | n;
      if (pos + from > 32)
        throw new Error(`convertRadix2: carry overflow pos=${pos} from=${from}`);
      pos += from;
      for (; pos >= to; pos -= to)
        res.push((carry >> pos - to & mask) >>> 0);
      const pow = powers[pos];
      if (pow === void 0)
        throw new Error("invalid carry");
      carry &= pow - 1;
    }
    carry = carry << to - pos & mask;
    if (!padding && pos >= from)
      throw new Error("Excess padding");
    if (!padding && carry > 0)
      throw new Error(`Non-zero padding: ${carry}`);
    if (padding && pos > 0)
      res.push(carry >>> 0);
    return res;
  }
  // @__NO_SIDE_EFFECTS__
  function radix2(bits, revPadding = false) {
    anumber(bits);
    if (bits <= 0 || bits > 32)
      throw new Error("radix2: bits should be in (0..32]");
    if (/* @__PURE__ */ radix2carry(8, bits) > 32 || /* @__PURE__ */ radix2carry(bits, 8) > 32)
      throw new Error("radix2: carry overflow");
    return {
      encode: (bytes) => {
        if (!isBytes(bytes))
          throw new Error("radix2.encode input should be Uint8Array");
        return convertRadix2(Array.from(bytes), 8, bits, !revPadding);
      },
      decode: (digits) => {
        anumArr("radix2.decode", digits);
        return Uint8Array.from(convertRadix2(digits, bits, 8, revPadding));
      }
    };
  }
  function unsafeWrapper(fn) {
    afn(fn);
    return function(...args) {
      try {
        return fn.apply(null, args);
      } catch (e) {
      }
    };
  }
  var BECH_ALPHABET = /* @__PURE__ */ chain(/* @__PURE__ */ alphabet("qpzry9x8gf2tvdw0s3jn54khce6mua7l"), /* @__PURE__ */ join(""));
  var POLYMOD_GENERATORS = [996825010, 642813549, 513874426, 1027748829, 705979059];
  function bech32Polymod(pre) {
    const b = pre >> 25;
    let chk = (pre & 33554431) << 5;
    for (let i = 0; i < POLYMOD_GENERATORS.length; i++) {
      if ((b >> i & 1) === 1)
        chk ^= POLYMOD_GENERATORS[i];
    }
    return chk;
  }
  function bechChecksum(prefix, words, encodingConst = 1) {
    const len = prefix.length;
    let chk = 1;
    for (let i = 0; i < len; i++) {
      const c = prefix.charCodeAt(i);
      if (c < 33 || c > 126)
        throw new Error(`Invalid prefix (${prefix})`);
      chk = bech32Polymod(chk) ^ c >> 5;
    }
    chk = bech32Polymod(chk);
    for (let i = 0; i < len; i++)
      chk = bech32Polymod(chk) ^ prefix.charCodeAt(i) & 31;
    for (let v of words)
      chk = bech32Polymod(chk) ^ v;
    for (let i = 0; i < 6; i++)
      chk = bech32Polymod(chk);
    chk ^= encodingConst;
    return BECH_ALPHABET.encode(convertRadix2([chk % powers[30]], 30, 5, false));
  }
  // @__NO_SIDE_EFFECTS__
  function genBech32(encoding) {
    const ENCODING_CONST = encoding === "bech32" ? 1 : 734539939;
    const _words = /* @__PURE__ */ radix2(5);
    const fromWords = _words.decode;
    const toWords = _words.encode;
    const fromWordsUnsafe = unsafeWrapper(fromWords);
    function encode(prefix, words, limit = 90) {
      astr("bech32.encode prefix", prefix);
      if (isBytes(words))
        words = Array.from(words);
      anumArr("bech32.encode", words);
      const plen = prefix.length;
      if (plen === 0)
        throw new TypeError(`Invalid prefix length ${plen}`);
      const actualLength = plen + 7 + words.length;
      if (limit !== false && actualLength > limit)
        throw new TypeError(`Length ${actualLength} exceeds limit ${limit}`);
      const lowered = prefix.toLowerCase();
      const sum = bechChecksum(lowered, words, ENCODING_CONST);
      return `${lowered}1${BECH_ALPHABET.encode(words)}${sum}`;
    }
    function decode(str, limit = 90) {
      astr("bech32.decode input", str);
      const slen = str.length;
      if (slen < 8 || limit !== false && slen > limit)
        throw new TypeError(`invalid string length: ${slen} (${str}). Expected (8..${limit})`);
      const lowered = str.toLowerCase();
      if (str !== lowered && str !== str.toUpperCase())
        throw new Error(`String must be lowercase or uppercase`);
      const sepIndex = lowered.lastIndexOf("1");
      if (sepIndex === 0 || sepIndex === -1)
        throw new Error(`Letter "1" must be present between prefix and data only`);
      const prefix = lowered.slice(0, sepIndex);
      const data = lowered.slice(sepIndex + 1);
      if (data.length < 6)
        throw new Error("Data must be at least 6 characters long");
      const words = BECH_ALPHABET.decode(data).slice(0, -6);
      const sum = bechChecksum(prefix, words, ENCODING_CONST);
      if (!data.endsWith(sum))
        throw new Error(`Invalid checksum in ${str}: expected "${sum}"`);
      return { prefix, words };
    }
    const decodeUnsafe = unsafeWrapper(decode);
    function decodeToBytes(str) {
      const { prefix, words } = decode(str, false);
      return { prefix, words, bytes: fromWords(words) };
    }
    function encodeFromBytes(prefix, bytes) {
      return encode(prefix, toWords(bytes));
    }
    return {
      encode,
      decode,
      encodeFromBytes,
      decodeToBytes,
      decodeUnsafe,
      fromWords,
      fromWordsUnsafe,
      toWords
    };
  }
  var bech32 = /* @__PURE__ */ genBech32("bech32");

  // src/worker/error-map.js
  var SW_ERROR_MAP = {
    36864: { code: "OK", message: "ok" },
    27264: { code: "SW_WRONG_DATA", message: "the device refused the data \u2014 it could not read the request" },
    27266: { code: "SW_FILE_NOT_FOUND", message: "that identity is not on the device" },
    27268: { code: "SW_FILE_FULL", message: "that slot is occupied \u2014 delete it first" },
    27270: { code: "SW_INCORRECT_PARAMS", message: "the device refused the parameters" },
    27271: { code: "SW_LC_INCONSISTENT", message: "the device refused the command length" },
    27272: { code: "SW_REFERENCED_DATA_NOT_FOUND", message: "nothing there to operate on" },
    27392: { code: "SW_INCORRECT_P1P2", message: "the device refused the command parameters" },
    // The touch word: the consent window closed without a press (15 s), or a
    // second vendor request arrived while a window was parked (the queue
    // exists so the client never provokes that one).
    27013: { code: "SW_TOUCH_REQUIRED", message: "touch timed out \u2014 the device asked for a touch and none came" },
    27904: { code: "SW_INS_NOT_SUPPORTED", message: "the device does not serve that command" },
    28416: { code: "SW_STORE_FAULT", message: "the device could not complete the operation \u2014 its store faulted" }
  };

  // src/popup/keys.js
  function npubBech32(hexNpub) {
    return bech32.encode("npub", bech32.toWords(hexToBytes(hexNpub)));
  }
  var SW_WORDS = Object.fromEntries(
    Object.entries(SW_ERROR_MAP).map(([sw, v]) => [Number(sw), v.message])
  );

  // src/prompt/identity.js
  function identityLine(slot, keys) {
    if (!Number.isInteger(slot) || slot < 0 || slot > 7) return null;
    if (!Array.isArray(keys)) return `with the key in slot ${slot}`;
    const k = keys.find((r) => r.idx === slot);
    if (!k) return "no active key is set on the device";
    const npub = npubBech32(k.pubkey);
    return `with ${npub.slice(0, 20)}\u2026${npub.slice(-4)} (slot ${slot})`;
  }

  // src/prompt/request-render.js
  function requestRender(preview2, method2) {
    const m = String(method2 ?? "");
    return { chip: m || "unknown", headline: (preview2 ?? "").trim() || m || "unknown" };
  }

  // src/prompt/remember-copy.js
  function rememberCopy(host2) {
    const site = host2 && host2 !== "unknown site" ? host2 : "this site";
    return `Remember this choice for ${site} \u2014 for this action only; the device touch is still required every time.`;
  }

  // src/prompt/touch-state.js
  var TOUCH_TEXT = "touch your fapico2 board";
  var LOST_CONNECTION_TEXT = "connection to the extension was lost \u2014 check the site";
  function successBeat(method2) {
    switch (String(method2 ?? "").toLowerCase()) {
      case "sign_event":
        return "signed.";
      case "get_public_key":
        return "shown.";
      case "nip44_encrypt":
        return "encrypted.";
      case "nip44_decrypt":
        return "decrypted.";
      case "list_keys":
        return "listed.";
      default:
        return "done.";
    }
  }
  function settleBeat(method2, { outcome: outcome2, message } = {}) {
    if (outcome2 === "err") {
      return { text: String(message ?? ""), err: true };
    }
    return { text: successBeat(method2), err: false };
  }

  // src/prompt/prompt.js
  var $ = (id) => document.getElementById(id);
  var params = new URLSearchParams(location.search);
  var requestId = params.get("request") ?? "";
  var method = params.get("method") ?? "";
  var host = params.get("host") ?? "unknown site";
  var preview = params.get("preview") ?? "";
  var api = createPortClient({ name: `nostr-prompt-${requestId}` });
  $("host").textContent = host;
  $("remember-note").textContent = rememberCopy(host);
  var render = requestRender(preview, method);
  $("method-chip").textContent = render.chip;
  $("headline").textContent = render.headline;
  $("hint").textContent = method === "get_public_key" ? "Your npub is public \u2014 which sites see it is your call." : "Nothing happens until you approve.";
  var withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("slow")), ms))]);
  if (method !== "list_keys") {
    (async () => {
      try {
        const slot = (await withTimeout(api.call("get_active_slot"), 1500))?.slot;
        let keys = null;
        try {
          keys = await withTimeout(api.call("list_keys"), 1500);
        } catch {
        }
        const line = identityLine(slot, keys);
        if (line) {
          $("identity").textContent = line;
          $("identity").hidden = false;
        }
      } catch {
      }
    })();
  }
  var touchBar = $("touch-bar");
  var outcome = $("outcome");
  var done = false;
  var once = (fn) => (...args) => {
    if (done) return;
    done = true;
    fn(...args);
  };
  var showOutcome = once((beat) => {
    touchBar.hidden = true;
    touchBar.classList.remove("on");
    outcome.hidden = false;
    outcome.textContent = beat.text;
    outcome.className = `outcome${beat.err ? " err" : ""}`;
  });
  var showLostConnection = once(() => {
    touchBar.hidden = true;
    touchBar.classList.remove("on");
    outcome.hidden = false;
    outcome.textContent = LOST_CONNECTION_TEXT;
    outcome.className = "outcome err";
  });
  function showTouch() {
    touchBar.hidden = false;
    touchBar.classList.add("on");
    $("touch-text").textContent = TOUCH_TEXT;
    $("actions").hidden = true;
  }
  api.onEvent((frame) => {
    if (frame.event !== "prompt-settled") return;
    showOutcome(settleBeat(method, frame));
    setTimeout(() => window.close(), 800);
  });
  api.onDisconnect(() => {
    if (done) return;
    showLostConnection();
  });
  $("approve").addEventListener("click", () => {
    api.call("prompt_decision", {
      requestId,
      approve: true,
      remember: $("remember").checked
    }).then((res) => res?.delivered === false ? showLostConnection() : showTouch()).catch(showLostConnection);
  });
  $("deny").addEventListener("click", () => {
    api.call("prompt_decision", { requestId, approve: false }).finally(() => window.close());
  });
})();
/*! Bundled license information:

@noble/hashes/esm/utils.js:
  (*! noble-hashes - MIT License (c) 2022 Paul Miller (paulmillr.com) *)

@scure/base/lib/esm/index.js:
  (*! scure-base - MIT License (c) 2022 Paul Miller (paulmillr.com) *)
*/
