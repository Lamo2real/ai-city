// Draws the Jarvis icon as a PNG with no dependencies.
// Usage: node scripts/make-icon.js <size> <out.png>
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const size = Number(process.argv[2]);
const out = process.argv[3];
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
// Distance-based coverage gives smooth edges at any size.
const edge = (d) => Math.max(0, Math.min(1, 0.5 - d * size));
const SIDE = 0.40; // macOS icons leave a margin around the shape
const squircle = (x, y) => Math.pow(Math.pow(Math.abs(x), 5) + Math.pow(Math.abs(y), 5), 1 / 5) - SIDE;

// One glowing ring on near-black: the Jarvis core, reduced to what reads at Dock size.
function pixel(x, y) {
  const r = Math.hypot(x, y);
  let c = mix([44, 44, 48], [8, 8, 10], Math.max(0, Math.min(1, (y + SIDE) / (2 * SIDE))));
  c = mix(c, [255, 140, 0], 0.5 * Math.exp(-Math.pow((r - 0.2) / 0.075, 2)));
  const warm = mix([255, 190, 90], [255, 122, 0], Math.max(0, Math.min(1, (y + 0.2) / 0.4)));
  c = mix(c, warm, edge(Math.abs(r - 0.2) - 0.032));
  c = mix(c, [255, 244, 225], edge(r - 0.058));
  return [...c, edge(squircle(x, y)) * 255];
}

const raw = Buffer.alloc((size * 4 + 1) * size);
for (let y = 0; y < size; y++) {
  const row = y * (size * 4 + 1);
  for (let x = 0; x < size; x++) {
    const p = pixel((x + 0.5) / size - 0.5, (y + 0.5) / size - 0.5);
    p.forEach((v, i) => { raw[row + 1 + x * 4 + i] = Math.round(v); });
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => (buf.reduce((c, b) => crcTable[(c ^ b) & 255] ^ (c >>> 8), 0xffffffff) ^ 0xffffffff) >>> 0;
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, sum]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(size, 0);
ihdr.writeUInt32BE(size, 4);
ihdr.set([8, 6, 0, 0, 0], 8);
writeFileSync(out, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
