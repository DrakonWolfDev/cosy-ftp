const fs = require('node:fs/promises');
const path = require('node:path');

async function main() {
  const seen = new Set();
  const sections = [
    'Cosy FTP — bundled JavaScript library notices',
    'Electron/Chromium notices are also supplied by the Electron distribution.',
  ];
  async function visit(name, from = process.cwd()) {
    let entry;
    try {
      entry = require.resolve(name, { paths: [from] });
    } catch {
      return;
    }
    let directory = path.dirname(entry);
    let metadata;
    for (;;) {
      try {
        const item = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
        if (item.name === name) {
          metadata = item;
          break;
        }
      } catch {}
      const parent = path.dirname(directory);
      if (parent === directory) throw new Error(`Cannot locate license metadata for ${name}`);
      directory = parent;
    }
    if (seen.has(directory)) return;
    seen.add(directory);
    const licenses = (await fs.readdir(directory)).filter((file) =>
      /^(licen[cs]e|copying|notice)(\.|$)/i.test(file),
    );
    if (!licenses.length) throw new Error(`No license text found for bundled dependency ${name}`);
    sections.push(
      `\n${'='.repeat(72)}\n${metadata.name} ${metadata.version}\n${licenses.join(', ')}\n`,
    );
    for (const file of licenses)
      sections.push(await fs.readFile(path.join(directory, file), 'utf8'));
    for (const dependency of Object.keys({
      ...metadata.dependencies,
      ...metadata.optionalDependencies,
    }).sort())
      await visit(dependency, directory);
  }
  for (const name of ['basic-ftp', 'ssh2', 'zod', 'react', 'react-dom', 'lucide-react'])
    await visit(name);
  await fs.mkdir('build', { recursive: true });
  await fs.writeFile('build/THIRD_PARTY_NOTICES.txt', `${sections.join('\n').trimEnd()}\n`);
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
