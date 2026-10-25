const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');

async function main() {
  const svg = path.resolve('build/icon.svg');
  await sharp(svg).resize(512, 512).png().toFile('build/icon.png');
  // Modern Windows ICO entries can contain PNG payloads. Include multiple
  // resolutions so shell/taskbar rendering stays crisp at different scales.
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const payloads = await Promise.all(
    sizes.map((size) => sharp(svg).resize(size, size).png().toBuffer()),
  );
  const header = Buffer.alloc(6 + sizes.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((size, index) => {
    const base = 6 + index * 16;
    header[base] = size === 256 ? 0 : size;
    header[base + 1] = header[base];
    header.writeUInt16LE(1, base + 4);
    header.writeUInt16LE(32, base + 6);
    header.writeUInt32LE(payloads[index].length, base + 8);
    header.writeUInt32LE(offset, base + 12);
    offset += payloads[index].length;
  });
  await fs.writeFile('build/icon.ico', Buffer.concat([header, ...payloads]));
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
