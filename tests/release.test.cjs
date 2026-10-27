const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { preflight, prepare } = require('../scripts/prepare-release.cjs');
const { version } = require('../package.json');

test('release requires explicit readiness, website token and matching version tag', () => {
  assert.throws(() => preflight({}), /COSY_FTP_RELEASE_APPROVED/);
  assert.throws(() => preflight({ RELEASE_APPROVED: 'true' }), /SITE_TOKEN/);
  assert.throws(
    () => preflight({ RELEASE_APPROVED: 'true', SITE_TOKEN: 'test', RELEASE_TAG: 'v0.0.0' }),
    /tag/,
  );
  preflight({ RELEASE_APPROVED: 'true', SITE_TOKEN: 'test', RELEASE_TAG: `v${version}` });
});

test('only a complete, unambiguous package set produces the website event and valid checksums', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cosy-release-'));
  try {
    const input = path.join(root, 'input');
    const output = path.join(root, 'output');
    const event = path.join(root, 'event.json');
    fs.mkdirSync(input);
    for (const ext of ['exe', 'deb', 'AppImage'])
      fs.writeFileSync(path.join(input, `original.${ext}`), ext);
    assert.throws(() => prepare(input, output, event), /rpm/);
    assert.equal(fs.existsSync(event), false);
    fs.writeFileSync(path.join(input, 'original.rpm'), 'rpm');
    assert.throws(() => prepare(input, output, event), /source\/notice asset/);
    for (const name of [
      `cosy-ftp-${version}-windows-sources.tar.gz`,
      `cosy-ftp-${version}-linux-sources.tar.gz`,
      `cosy-ftp-${version}-linux-system-sources.tar.gz`,
      'NATIVE_NOTICES_windows.txt', 'NATIVE_NOTICES_linux.txt', 'LINUX_SYSTEM_NOTICES.txt',
      'native-inventory-windows.json', 'native-inventory-linux.json', 'linux-payload-inventory.json',
    ]) fs.writeFileSync(path.join(input, name), name);
    prepare(input, output, event);
    const payload = JSON.parse(fs.readFileSync(event)).client_payload;
    assert.equal(payload.project, 'cosy_ftp');
    assert.equal(payload.tag, `v${version}`);
    assert.equal(Object.keys(payload.artifacts).length, 4);
    for (const line of fs
      .readFileSync(path.join(output, 'SHA256SUMS.txt'), 'utf8')
      .trim()
      .split('\n')) {
      const [hash, filename] = line.split('  ');
      assert.equal(
        hash,
        createHash('sha256')
          .update(fs.readFileSync(path.join(output, filename)))
          .digest('hex'),
      );
      assert.ok(fs.existsSync(path.join(output, filename)));
    }
    fs.writeFileSync(path.join(input, 'duplicate.exe'), 'duplicate');
    assert.throws(() => prepare(input, output, event), /exactly one exe/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
