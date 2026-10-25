import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SettingsStore, type Secrets } from '../electron/store';

test('a failed trust-store write preserves the fingerprint in memory and malformed records are not overwritten', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cosy-trust-failure-'));
  const secrets: Secrets = {
    async available() {
      return false;
    },
    async encrypt(value) {
      return value;
    },
    async decrypt(value) {
      return value;
    },
  };
  try {
    const directory = path.join(root, 'store');
    const file = path.join(directory, 'settings.json');
    const settings = new SettingsStore(file, secrets);
    await settings.load();
    await settings.trustHost('host:22', 'SHA256:keep');
    await fs.rename(directory, `${directory}-backup`);
    await fs.writeFile(directory, 'blocked');
    await assert.rejects(settings.forgetHost('host:22'));
    assert.equal(settings.hostKey('host:22'), 'SHA256:keep');
    const corrupt = path.join(root, 'corrupt.json');
    const text = JSON.stringify({
      version: 1,
      profiles: [],
      hosts: { 'host:22': { invalid: true } },
    });
    await fs.writeFile(corrupt, text);
    await assert.rejects(new SettingsStore(corrupt, secrets).load(), /preserved/);
    assert.equal(await fs.readFile(corrupt, 'utf8'), text);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('forgetting one trusted host preserves other fingerprints, profiles and encrypted credentials across reloads', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cosy-trust-'));
  const secrets: Secrets = {
    async available() {
      return true;
    },
    async encrypt(value) {
      return Buffer.from(value).toString('base64');
    },
    async decrypt(value) {
      return Buffer.from(value, 'base64').toString();
    },
  };
  try {
    const file = path.join(root, 'settings.json');
    const settings = new SettingsStore(file, secrets);
    await settings.load();
    const profile = await settings.save({
      name: 'Saved',
      host: 'one.example',
      port: 22,
      protocol: 'sftp',
      username: 'tester',
      initialPath: '/',
      allowInsecure: false,
      rememberPassword: true,
      password: 'test-password',
    });
    await settings.trustHost('one.example:22', 'SHA256:first');
    await settings.trustHost('two.example:22', 'SHA256:second');
    await settings.forgetHost('one.example:22');
    const reloaded = new SettingsStore(file, secrets);
    await reloaded.load();
    assert.equal(reloaded.hostKey('one.example:22'), undefined);
    assert.equal(reloaded.hostKey('__proto__'), undefined);
    assert.deepEqual(reloaded.trustedHosts(), [
      { host: 'two.example:22', fingerprint: 'SHA256:second' },
    ]);
    assert.deepEqual(reloaded.list(), [profile]);
    assert.equal(await reloaded.password(profile.id), 'test-password');
    await reloaded.forgetHost('missing.example:22');
    assert.equal(reloaded.trustedHosts().length, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
