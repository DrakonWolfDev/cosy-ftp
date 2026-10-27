// Keep package naming and the website release event in one versioned contract.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const version = require('../package.json').version;
const formats = { windows: 'exe', linux_deb: 'deb', linux_rpm: 'rpm', linux_appimage: 'AppImage' };

function preflight(env = process.env) {
  if (env.RELEASE_APPROVED !== 'true')
    throw new Error('Set COSY_FTP_RELEASE_APPROVED=true only when ready for public downloads.');
  if (!env.SITE_TOKEN)
    throw new Error('WOLF_FORGE_SITE_TOKEN is required for the website release event.');
  if (env.RELEASE_TAG !== `v${version}`) throw new Error('Release tag must match the app version.');
  const config = require('../src-tauri/tauri.conf.json');
  const cargo = fs.readFileSync(path.join(__dirname, '../src-tauri/Cargo.toml'), 'utf8');
  const rustVersion = cargo.match(/^version = "([^"]+)"/m)?.[1];
  if (config.version !== version || rustVersion !== version)
    throw new Error('Package, Tauri and Rust versions must match.');
}

function prepare(input, output, eventFile = 'release-event.json') {
  const files = [];
  function walk(dir) {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      if (item.isDirectory()) walk(file);
      else if (item.isFile()) files.push(file);
    }
  }
  walk(input);
  const selected = Object.entries(formats).map(([platform, extension]) => {
    const matches = files.filter((file) => file.endsWith(`.${extension}`));
    if (matches.length !== 1)
      throw new Error(`Expected exactly one ${extension} package; found ${matches.length}`);
    const name = `cosy-ftp-${version}${platform === 'windows' ? '-windows' : ''}.${extension}`;
    return { platform, file: matches[0], name };
  });
  const supportingNames = [
    `cosy-ftp-${version}-windows-sources.tar.gz`,
    `cosy-ftp-${version}-linux-sources.tar.gz`,
    `cosy-ftp-${version}-linux-system-sources.tar.gz`,
    'NATIVE_NOTICES_windows.txt', 'NATIVE_NOTICES_linux.txt', 'LINUX_SYSTEM_NOTICES.txt',
    'native-inventory-windows.json', 'native-inventory-linux.json', 'linux-payload-inventory.json',
  ];
  const supporting = supportingNames.map((name) => {
    const matches = files.filter((file) => path.basename(file) === name);
    if (matches.length !== 1 || fs.statSync(matches[0]).size === 0)
      throw new Error(`Expected exactly one nonempty release source/notice asset: ${name}`);
    return { file: matches[0], name };
  });
  fs.mkdirSync(output, { recursive: true });
  const sums = [];
  for (const { file, name } of [...selected, ...supporting]) {
    const bytes = fs.readFileSync(file);
    fs.writeFileSync(path.join(output, name), bytes);
    sums.push(`${createHash('sha256').update(bytes).digest('hex')}  ${name}`);
  }
  fs.writeFileSync(path.join(output, 'SHA256SUMS.txt'), `${sums.join('\n')}\n`);
  fs.writeFileSync(
    eventFile,
    JSON.stringify(
      {
        event_type: 'desktop_release_published',
        client_payload: {
          project: 'cosy_ftp',
          version,
          tag: `v${version}`,
          artifacts: Object.fromEntries(selected.map(({ platform, name }) => [platform, name])),
        },
      },
      null,
      2,
    ) + '\n',
  );
}
module.exports = { preflight, prepare };
if (require.main === module) {
  try {
    if (process.argv[2] === '--preflight') preflight();
    else prepare(process.argv[2], process.argv[3]);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
