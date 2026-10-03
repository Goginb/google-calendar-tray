'use strict';

const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const svg = Buffer.from(`
<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="blue" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#4285f4"/><stop offset="1" stop-color="#0b57d0"/>
    </linearGradient>
  </defs>
  <rect x="20" y="29" width="216" height="207" rx="50" fill="url(#blue)"/>
  <path d="M20 91h216v-12c0-28-22-50-50-50H70c-28 0-50 22-50 50z" fill="#ea4335"/>
  <path d="M76 17v37M180 17v37" stroke="#fff" stroke-width="18" stroke-linecap="round"/>
  <path d="M69 126h47v40H69zm71 0h47v40h-47zM69 183h47v40H69zm71 0h47v40h-47z" fill="#fff" opacity=".96"/>
</svg>`);

function makeIco(pngBuffers, sizes) {
  const headerSize = 6 + (16 * pngBuffers.length);
  const totalSize = headerSize + pngBuffers.reduce((sum, buffer) => sum + buffer.length, 0);
  const result = Buffer.alloc(totalSize);
  result.writeUInt16LE(0, 0);
  result.writeUInt16LE(1, 2);
  result.writeUInt16LE(pngBuffers.length, 4);
  let offset = headerSize;
  pngBuffers.forEach((buffer, index) => {
    const entry = 6 + (index * 16);
    result.writeUInt8(sizes[index] === 256 ? 0 : sizes[index], entry);
    result.writeUInt8(sizes[index] === 256 ? 0 : sizes[index], entry + 1);
    result.writeUInt8(0, entry + 2);
    result.writeUInt8(0, entry + 3);
    result.writeUInt16LE(1, entry + 4);
    result.writeUInt16LE(32, entry + 6);
    result.writeUInt32LE(buffer.length, entry + 8);
    result.writeUInt32LE(offset, entry + 12);
    buffer.copy(result, offset);
    offset += buffer.length;
  });
  return result;
}

async function main() {
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const pngBuffers = await Promise.all(sizes.map((size) => sharp(svg).resize(size, size).png().toBuffer()));
  const buildDir = path.join(__dirname, '..', 'build');
  fs.mkdirSync(buildDir, { recursive: true });
  fs.writeFileSync(path.join(buildDir, 'icon.ico'), makeIco(pngBuffers, sizes));
  fs.writeFileSync(path.join(buildDir, 'icon.png'), pngBuffers.at(-1));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
