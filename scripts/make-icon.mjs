// Generates media/icon.png (the Marketplace icon) from primitives.
//
// The Marketplace requires a PNG, and rasterising an SVG needs a browser or a
// native library — neither of which belongs in the dependencies of an extension
// that otherwise has none. So the mark is drawn here: a supersampled RGBA buffer,
// box-downsampled for antialiasing, then encoded as a PNG with zlib, which node
// ships. The same mark is in media/icon.svg for the activity bar.
//
//   node scripts/make-icon.mjs
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

const SIZE = 128; // what the Marketplace shows
const SCALE = 4; // supersampling factor
const W = SIZE * SCALE;

const INK = [11, 18, 32, 255]; // #0B1220, the gallery banner colour
const RUNG = [16, 185, 129, 255]; // #10B981, the ladder
const RUNG_DIM = [45, 212, 191, 255]; // #2DD4BF, the lower rungs
const DEFECT = [239, 68, 68, 255]; // #EF4444, the gap the tool is looking for

const pixels = new Uint8Array(W * W * 4);

function blend(x, y, [r, g, b, a]) {
  if (x < 0 || y < 0 || x >= W || y >= W) return;
  const i = (y * W + x) * 4;
  const alpha = a / 255;
  pixels[i] = Math.round(pixels[i] * (1 - alpha) + r * alpha);
  pixels[i + 1] = Math.round(pixels[i + 1] * (1 - alpha) + g * alpha);
  pixels[i + 2] = Math.round(pixels[i + 2] * (1 - alpha) + b * alpha);
  pixels[i + 3] = Math.max(pixels[i + 3], a);
}

/** fillRoundRect fills a rounded rectangle in supersampled coordinates. */
function fillRoundRect(x0, y0, w, h, radius, color) {
  const x1 = x0 + w;
  const y1 = y0 + h;
  const r = Math.min(radius, w / 2, h / 2);
  for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
    for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
      // Only the corners need the distance test.
      const dx = x < x0 + r ? x0 + r - x : x > x1 - r - 1 ? x - (x1 - r - 1) : 0;
      const dy = y < y0 + r ? y0 + r - y : y > y1 - r - 1 ? y - (y1 - r - 1) : 0;
      if (dx * dx + dy * dy <= r * r) blend(x, y, color);
    }
  }
}

/** strokeCircle draws a ring, for the lens. */
function strokeCircle(cx, cy, radius, thickness, color) {
  const outer = radius + thickness / 2;
  const inner = radius - thickness / 2;
  for (let y = Math.floor(cy - outer); y <= Math.ceil(cy + outer); y++) {
    for (let x = Math.floor(cx - outer); x <= Math.ceil(cx + outer); x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d <= outer && d >= inner) blend(x, y, color);
    }
  }
}

/** strokeLine draws a thick line, for the lens handle. */
function strokeLine(x0, y0, x1, y1, thickness, color) {
  const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0));
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    fillRoundRect(x0 + (x1 - x0) * t - thickness / 2, y0 + (y1 - y0) * t - thickness / 2, thickness, thickness, thickness / 2, color);
  }
}

const u = (n) => n * SCALE; // design units (0–128) to supersampled pixels

// Background.
fillRoundRect(0, 0, W, W, u(26), INK);

// The ladder: four rungs of increasing height, read left to right like a bitrate
// ladder in a master playlist.
const rungs = [
  { x: 20, h: 26, color: RUNG_DIM },
  { x: 41, h: 44, color: RUNG_DIM },
  { x: 62, h: 62, color: RUNG },
  { x: 83, h: 84, color: RUNG },
];
const baseline = 104;
for (const rung of rungs) {
  fillRoundRect(u(rung.x), u(baseline - rung.h), u(14), u(rung.h), u(4), rung.color);
}

// The defect: a gap cut across the tallest rung, in the colour of a BAD finding.
// It is what the tool is for — the manifest looks complete and the media is not.
fillRoundRect(u(80), u(46), u(20), u(7), u(3), INK);
fillRoundRect(u(83), u(47), u(14), u(5), u(2), DEFECT);

// The lens, over the top-left of the ladder.
strokeCircle(u(44), u(46), u(23), u(7), [226, 232, 240, 255]);
strokeLine(u(60), u(62), u(74), u(76), u(9), [226, 232, 240, 255]);

// Box-downsample to the final size: this is where the antialiasing comes from.
const out = new Uint8Array(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const acc = [0, 0, 0, 0];
    for (let sy = 0; sy < SCALE; sy++) {
      for (let sx = 0; sx < SCALE; sx++) {
        const i = ((y * SCALE + sy) * W + (x * SCALE + sx)) * 4;
        for (let c = 0; c < 4; c++) acc[c] += pixels[i + c];
      }
    }
    const o = (y * SIZE + x) * 4;
    for (let c = 0; c < 4; c++) out[o + c] = Math.round(acc[c] / (SCALE * SCALE));
  }
}

// ------------------------------------------------------------------ PNG output

function encodePng(rgba, width, height) {
  // One filter byte (0 = None) per scanline, then the raw RGBA bytes.
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// The write happens last: the CRC table above is a top-level const, so calling the
// encoder before this point would hit it before initialisation.
fs.mkdirSync(path.join('media'), { recursive: true });
fs.writeFileSync(path.join('media', 'icon.png'), encodePng(out, SIZE, SIZE));
console.log(`wrote media/icon.png (${SIZE}×${SIZE})`);
