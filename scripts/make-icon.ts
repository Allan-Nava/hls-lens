// Writes or verifies media/icon.png.
//
//   npm run icon          write media/icon.png from the generator
//   npm run icon:check    verify the committed PNG against it, write nothing
//
// Everything worth testing — the drawing, the PNG encoder and decoder, the pixel
// comparison — is in src/core/png.ts. What is left here is reading a file, writing a
// file, and choosing an exit code.
import * as fs from 'fs';
import * as path from 'path';

import { drawIcon, encodePng, decodePng, comparePixels } from '../src/core/png';

const CHECK = process.argv.includes('--check');
const ICON = path.join('media', 'icon.png');

const { size, rgba } = drawIcon();

if (!CHECK) {
  fs.mkdirSync('media', { recursive: true });
  fs.writeFileSync(ICON, encodePng(rgba, size, size));
  console.log(`wrote ${ICON} (${size}×${size})`);
} else if (!fs.existsSync(ICON)) {
  fail(`${ICON} is missing — run 'npm run icon' and commit the result`);
} else {
  let decoded;
  try {
    decoded = decodePng(fs.readFileSync(ICON));
  } catch (err) {
    fail(`${ICON} was not produced by the generator (${(err as Error).message}) — run 'npm run icon' and commit the result`);
  }
  if (decoded!.width !== size || decoded!.height !== size) {
    fail(`${ICON} is ${decoded!.width}×${decoded!.height}, the generator draws ${size}×${size} — run 'npm run icon'`);
  }
  const diff = comparePixels(decoded!.rgba, rgba);
  if (diff) {
    fail(
      `${ICON} is stale — ${diff.differing} pixel(s) differ from the generator, first at ` +
        `(${diff.firstPixel % size}, ${Math.floor(diff.firstPixel / size)}). Run 'npm run icon' and commit the result`,
    );
  }
  console.log(`${ICON} matches the generator (${size}×${size}, pixel for pixel)`);
}

/** fail prints a GitHub Actions error annotation and stops. */
function fail(message: string): never {
  console.error(`::error::${message}`);
  process.exit(1);
}
