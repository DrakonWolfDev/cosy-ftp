const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

async function main() {
  const artifacts = [];
  for (const directory of ['release', 'release/linux']) {
    for (const item of await fsp.readdir(directory, { withFileTypes: true }).catch(() => [])) {
      if (item.isFile() && /\.(exe|AppImage|deb)$/.test(item.name))
        artifacts.push(path.join(directory, item.name));
    }
  }
  const lines = [];
  for (const file of artifacts.sort()) {
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    lines.push(`${hash.digest('hex')}  ${path.relative('release', file).replaceAll('\\', '/')}`);
  }
  await fsp.writeFile('release/SHA256SUMS.txt', `${lines.join('\n')}\n`);
  console.log(`${lines.length} preview artifact checksums written to release/SHA256SUMS.txt`);
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
