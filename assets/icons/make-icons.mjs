// US-1689 requisite: manifest icons. A minimal generator (zlib + hand-built
// PNG chunks, no image dependency) producing a flat charcoal square with a
// 2px amber border — the fapico2 board's LED colour. Run once; the PNGs are
// committed assets.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

function crc32(buf) {
  let c, table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, path) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const raw = Buffer.alloc(size * size * 3);
  const border = Math.max(1, Math.round(size / 16));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 3;
      const edge = x < border || y < border || x >= size - border || y >= size - border;
      // charcoal 0x1e2229, amber 0xffb340
      const [r, g, b] = edge ? [0xff, 0xb3, 0x40] : [0x1e, 0x22, 0x29];
      raw[i] = r; raw[i + 1] = g; raw[i + 2] = b;
    }
  }
  const stride = size * 3;
  const filtered = Buffer.alloc(size * (stride + 1));
  for (let y = 0; y < size; y++) {
    filtered[y * (stride + 1)] = 0;
    raw.copy(filtered, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const pngBuf = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(filtered)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  writeFileSync(path, pngBuf);
  console.log(path, pngBuf.length, 'bytes');
}

png(16, new URL('./icon16.png', import.meta.url).pathname);
png(48, new URL('./icon48.png', import.meta.url).pathname);
png(128, new URL('./icon128.png', import.meta.url).pathname);
