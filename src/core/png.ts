// The icon as data: the drawing, the PNG encoder and decoder, and the pixel
// comparison the CI gate runs.
//
// The Marketplace requires a PNG, and rasterising an SVG needs a browser or a native
// library — neither of which belongs in the dependencies of an extension that has
// none. So the mark is drawn here from primitives: a supersampled RGBA buffer,
// box-downsampled for antialiasing, encoded with the zlib node ships. The same mark
// is in media/icon.svg for the activity bar.
//
// This lives in the core rather than in the script for the same reason everything
// else does: it is logic, and logic is tested. scripts/make-icon.ts is the I/O.
import * as zlib from 'zlib';

const SIZE = 128; // what the Marketplace shows
const SCALE = 4; // supersampling factor
const W = SIZE * SCALE;

const INK: RGBA = [11, 18, 32, 255]; // #0B1220, the gallery banner colour
const RUNG: RGBA = [16, 185, 129, 255]; // #10B981, the ladder
const RUNG_DIM: RGBA = [45, 212, 191, 255]; // #2DD4BF, the lower rungs
const DEFECT: RGBA = [239, 68, 68, 255]; // #EF4444, the gap the tool is looking for
const LENS: RGBA = [226, 232, 240, 255]; // #E2E8F0

export type RGBA = [number, number, number, number];

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * drawIcon renders the mark: four rungs of increasing height read left to right like
 * a bitrate ladder, a defect cut across the tallest one, and a lens over them.
 *
 * Deterministic by construction — no clock, no randomness, no environment — because
 * the committed PNG is checked against a fresh render on a machine that is not this
 * one.
 */
export function drawIcon(): { size: number; rgba: Uint8Array } {
  const pixels = new Uint8Array(W * W * 4);

  const blend = (x: number, y: number, [r, g, b, a]: RGBA): void => {
    if (x < 0 || y < 0 || x >= W || y >= W) return;
    const i = (y * W + x) * 4;
    const alpha = a / 255;
    pixels[i] = Math.round(pixels[i] * (1 - alpha) + r * alpha);
    pixels[i + 1] = Math.round(pixels[i + 1] * (1 - alpha) + g * alpha);
    pixels[i + 2] = Math.round(pixels[i + 2] * (1 - alpha) + b * alpha);
    pixels[i + 3] = Math.max(pixels[i + 3], a);
  };

  /** fillRoundRect fills a rounded rectangle in supersampled coordinates. */
  const fillRoundRect = (x0: number, y0: number, w: number, h: number, radius: number, color: RGBA): void => {
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
  };

  /** strokeCircle draws a ring, for the lens. */
  const strokeCircle = (cx: number, cy: number, radius: number, thickness: number, color: RGBA): void => {
    const outer = radius + thickness / 2;
    const inner = radius - thickness / 2;
    for (let y = Math.floor(cy - outer); y <= Math.ceil(cy + outer); y++) {
      for (let x = Math.floor(cx - outer); x <= Math.ceil(cx + outer); x++) {
        const d = Math.hypot(x - cx, y - cy);
        if (d <= outer && d >= inner) blend(x, y, color);
      }
    }
  };

  /** strokeLine draws a thick line, for the lens handle. */
  const strokeLine = (x0: number, y0: number, x1: number, y1: number, thickness: number, color: RGBA): void => {
    const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      fillRoundRect(
        x0 + (x1 - x0) * t - thickness / 2,
        y0 + (y1 - y0) * t - thickness / 2,
        thickness,
        thickness,
        thickness / 2,
        color,
      );
    }
  };

  const u = (n: number): number => n * SCALE; // design units (0–128) to supersampled pixels

  fillRoundRect(0, 0, W, W, u(26), INK);

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

  strokeCircle(u(44), u(46), u(23), u(7), LENS);
  strokeLine(u(60), u(62), u(74), u(76), u(9), LENS);

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
  return { size: SIZE, rgba: out };
}

/**
 * encodePng writes 8-bit RGBA, filter 0 on every scanline, one IDAT.
 *
 * `level` exists for the tests: the same pixels at two levels are two different byte
 * streams, which is precisely the situation the pixel comparison has to survive.
 */
export function encodePng(rgba: Uint8Array, width: number, height: number, level = 9): Buffer {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: None
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
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
    Buffer.from(PNG_SIGNATURE),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * decodePng reads back what encodePng wrote. It understands only that shape — 8-bit
 * RGBA, no interlace, filter 0 — because anything else in media/icon.png means the
 * file did not come from this generator, which is what the gate is there to catch.
 */
export function decodePng(png: Buffer): { width: number; height: number; rgba: Buffer } {
  if (png.length < 8 || !png.subarray(0, 8).equals(Buffer.from(PNG_SIGNATURE))) throw new Error('not a PNG');

  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  for (let at = 8; at + 8 <= png.length; ) {
    const length = png.readUInt32BE(at);
    const type = png.toString('ascii', at + 4, at + 8);
    // Without this, a file cut short reaches the readers below and surfaces as a
    // Buffer RangeError, which says nothing about the file being the problem.
    if (at + 12 + length > png.length) throw new Error(`truncated PNG: chunk ${type} claims ${length} bytes`);
    const data = png.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6) throw new Error(`expected 8-bit RGBA, got depth ${data[8]} colour type ${data[9]}`);
      if (data[12] !== 0) throw new Error('interlaced PNG');
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    at += 12 + length; // length + type + data + CRC
  }
  if (!width || !height) throw new Error('no IHDR');
  if (idat.length === 0) throw new Error('no IDAT');

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  if (raw.length !== (stride + 1) * height) throw new Error(`unexpected raw size ${raw.length}`);
  const rgba = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    if (filter !== 0) throw new Error(`scanline ${y} uses filter ${filter}; this generator writes 0`);
    raw.copy(rgba, y * stride, y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
  }
  return { width, height, rgba };
}

/**
 * comparePixels returns null when two images are identical, or how many pixels differ
 * and where the first one is. Pixels, not bytes: DEFLATE output is not fixed by the
 * PNG format, so the same image encoded by a different zlib is a different, equally
 * valid file — and a byte comparison fails on a machine where only the compressor
 * changed, which is exactly what it did in CI.
 */
export function comparePixels(
  actual: Uint8Array,
  expected: Uint8Array,
): { differing: number; firstPixel: number } | null {
  if (actual.length !== expected.length) {
    return { differing: Math.max(actual.length, expected.length) / 4, firstPixel: 0 };
  }
  let differing = 0;
  let firstPixel = -1;
  for (let i = 0; i < expected.length; i += 4) {
    if (
      actual[i] !== expected[i] ||
      actual[i + 1] !== expected[i + 1] ||
      actual[i + 2] !== expected[i + 2] ||
      actual[i + 3] !== expected[i + 3]
    ) {
      if (firstPixel < 0) firstPixel = i / 4;
      differing++;
    }
  }
  return differing === 0 ? null : { differing, firstPixel };
}

function pngChunk(type: string, data: Buffer): Buffer {
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

function crc32(buf: Buffer): number {
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
