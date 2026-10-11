// US-1708 — a minimal RFC 6455 WebSocket client over node:net, enough for
// the CDP session: one text-message channel, ping/pong, close. No
// permessage-deflate (never offered), no TLS (DevTools listens on loopback).
// The EPIC pins this: a plain Node script using CDP over WebSocket — no
// Playwright, no ws dependency.

import net from 'node:net';
import crypto from 'node:crypto';

export function wsConnect(url, { timeoutMs = 10_000 } = {}) {
  const { hostname, port, pathname } = new URL(url);
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const socket = net.connect(Number(port), hostname);
    socket.setTimeout(timeoutMs);

    let handshakeDone = false;
    let buffer = Buffer.alloc(0);
    let fragments = [];
    let fragmentOpcode = 0;

    const fail = (err) => {
      socket.destroy();
      reject(err);
    };

    socket.on('timeout', () => fail(new Error('websocket timeout')));
    socket.on('error', fail);

    socket.on('connect', () => {
      socket.write(
        `GET ${pathname} HTTP/1.1\r\n` +
          `Host: ${hostname}:${port}\r\n` +
          `Upgrade: websocket\r\n` +
          `Connection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\n` +
          `Sec-WebSocket-Version: 13\r\n\r\n`,
      );
    });

    const ws = {
      send(obj) {
        socket.write(encodeFrame(Buffer.from(JSON.stringify(obj)), 0x1));
      },
      close() {
        try {
          socket.write(encodeFrame(Buffer.alloc(0), 0x8));
        } catch { /* already gone */ }
        socket.destroy();
      },
      onmessage: null,
      onclose: null,
    };

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!handshakeDone) {
        const idx = buffer.indexOf('\r\n\r\n');
        if (idx === -1) return;
        const head = buffer.slice(0, idx).toString();
        if (!/HTTP\/1\.1 101/.test(head)) {
          return fail(new Error(`upgrade refused: ${head.split('\r\n')[0]}`));
        }
        const accept = /Sec-WebSocket-Accept: (.+)/.exec(head)?.[1]?.trim();
        const expect = crypto
          .createHash('sha1')
          .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
          .digest('base64');
        if (accept !== expect) return fail(new Error('bad Sec-WebSocket-Accept'));
        handshakeDone = true;
        buffer = buffer.slice(idx + 4);
        resolve(ws);
      }
      // Frames.
      for (;;) {
        const frame = decodeFrame(buffer);
        if (!frame) break;
        buffer = buffer.slice(frame.total);
        if (frame.opcode === 0x9) {
          socket.write(encodeFrame(frame.payload, 0xa)); // ping → pong
          continue;
        }
        if (frame.opcode === 0x8) {
          socket.destroy();
          ws.onclose?.();
          return;
        }
        if (frame.opcode === 0x1 || frame.opcode === 0x2) {
          fragmentOpcode = frame.opcode;
        }
        if (frame.fin) {
          const whole =
            fragments.length > 0
              ? Buffer.concat([...fragments, frame.payload])
              : frame.payload;
          fragments = [];
          if (frame.opcode === 0x0 && fragmentOpcode !== 0x1) continue;
          try {
            ws.onmessage?.(JSON.parse(whole.toString('utf8')));
          } catch { /* a non-JSON frame is not CDP's to send */ }
        } else {
          fragments.push(frame.payload);
        }
      }
    });
  });
}

function encodeFrame(payload, opcode) {
  const mask = crypto.randomBytes(4);
  const len = payload.length;
  let head;
  if (len < 126) {
    head = Buffer.from([0x80 | opcode, 0x80 | len]);
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = 0x80 | 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 0x80 | 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([head, mask, masked]);
}

function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const fin = (buf[0] & 0x80) !== 0;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    const big = buf.readBigUInt64BE(2);
    if (big > BigInt(64 * 1024 * 1024)) return null; // CDP messages stay sane
    len = Number(big);
    offset = 10;
  }
  const maskLen = masked ? 4 : 0;
  if (buf.length < offset + maskLen + len) return null;
  const payload = Buffer.alloc(len);
  if (masked) {
    const mask = buf.slice(offset, offset + 4);
    for (let i = 0; i < len; i++) {
      payload[i] = buf[offset + 4 + i] ^ mask[i % 4];
    }
  } else {
    buf.copy(payload, 0, offset + maskLen, offset + maskLen + len);
  }
  return { fin, opcode, payload, total: offset + maskLen + len };
}
