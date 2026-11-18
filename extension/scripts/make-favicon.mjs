#!/usr/bin/env node
// Regenerates whitepaper/favicon.ico from assets/icon.svg, so the site and the
// extension share one mark. Run from extension/: `npm run favicon`.
import { readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';

const SIZES = [16, 32, 48, 64];
const svg = await readFile(new URL('../assets/icon.svg', import.meta.url));
const { width } = await sharp(svg).metadata();

const pngs = await Promise.all(
  SIZES.map((size) =>
    sharp(svg, { density: (72 * size * 2) / width }).resize(size, size).png().toBuffer(),
  ),
);

// ICO container with PNG-encoded images: a 6-byte header, a 16-byte entry per
// image, then the PNG data.
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(SIZES.length, 4);
let offset = 6 + 16 * SIZES.length;
const entries = SIZES.map((size, i) => {
  const entry = Buffer.alloc(16);
  entry.writeUInt8(size % 256, 0);
  entry.writeUInt8(size % 256, 1);
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(pngs[i].length, 8);
  entry.writeUInt32LE(offset, 12);
  offset += pngs[i].length;
  return entry;
});

const out = new URL('../../whitepaper/favicon.ico', import.meta.url);
await writeFile(out, Buffer.concat([header, ...entries, ...pngs]));
console.log(`[Harbor] ✓ Wrote whitepaper/favicon.ico (${SIZES.join(', ')} px)`);
