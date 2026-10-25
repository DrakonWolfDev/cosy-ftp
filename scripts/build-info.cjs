const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

async function fingerprint() {
  const hash = createHash('sha256');
  async function visit(directory) {
    for (const item of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const file = path.join(directory, item.name);
      if (item.isDirectory()) await visit(file);
      else {
        hash.update(file.replaceAll('\\', '/'));
        hash.update(await fs.readFile(file));
      }
    }
  }
  for (const directory of ['electron', 'shared', 'src']) await visit(directory);
  for (const file of [
    'package.json',
    'package-lock.json',
    'index.html',
    'vite.config.ts',
    'tsconfig.backend.json',
  ]) {
    hash.update(file);
    hash.update(await fs.readFile(file));
  }
  return hash.digest('hex');
}
module.exports = { fingerprint };
if (require.main === module)
  fingerprint()
    .then((buildId) =>
      fs.writeFile('dist-electron/build-info.json', JSON.stringify({ buildId }, null, 2)),
    )
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
