// Draws the orange Jarvis core as a PNG with no dependencies.
// Usage: node scripts/make-icon.js <size> <out.png>
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const size = Number(process.argv[2]);
const out = process.argv[3];
const ORANGE = [255, 106, 26];
const AMBER = [255, 154, 60];
const RED = [255, 46, 26];
const BG = [18, 6, 3];
const WHITE = [255, 245, 232];

// Distance-based coverage gives smooth edges at any size.
const edge = (d) => Math.max(0, Math.min(1, 0.5 - d * size));
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const insideSquircle = (x, y) => Math.pow(Math.abs(x), 5) + Math.pow(Math.abs(y), 5) - Math.pow(0.46, 5);

function pixel(x, y) {
  const r = Math.hypot(x, y);
  const angle = Math.atan2(y, x);
  let c = mix(BG, ORANGE, Math.max(0, 0.22 - r * 0.45));
  const ring = (radius, width, color, on = true) => { if (on) c = mix(c, color, edge(Math.abs(r - radius) - width)); };
  ring(0.40, 0.006, ORANGE);
  ring(0.355, 0.016, AMBER, Math.sin(angle * 24) > -0.2);
  ring(0.27, 0.03, RED, Math.sin(angle * 3 + 0.6) > -0.55);
  ring(0.195, 0.006, WHITE);
  c = mix(c, AMBER, edge(r - 0.135));
  c = mix(c, WHITE, edge(r - 0.075));
  const alpha = edge(insideSquircle(x, y) * 3);
  return [...c, alpha * 255];
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
