import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import tls from 'node:tls';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { FtpEndpoint, LocalEndpoint, SftpEndpoint } from '../electron/endpoints';
import { copyFile, TransferQueue } from '../electron/transfers';
import type { Profile } from '../shared/types';
import { ftpServer } from './fixtures/ftp-server';
import { sftpServer } from './fixtures/sftp-server';

const skip =
  process.env.COSY_PROTOCOL_TESTS !== '1'
    ? 'Set COSY_PROTOCOL_TESTS=1 after installing tests/requirements.txt'
    : false;
function profile(port: number, secure = false): Profile {
  return {
    id: 'test',
    name: 'Loopback FTP',
    protocol: secure ? 'ftps' : 'ftp',
    host: secure ? 'localhost' : '127.0.0.1',
    port,
    username: 'tester',
    initialPath: '/',
    allowInsecure: !secure,
    hasPassword: false,
  };
}
async function fixture(secure = false) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cosy-ftp-'));
  const root = path.join(directory, 'files');
  await fs.mkdir(root);
  const server = await ftpServer(root, secure);
  const endpoints: FtpEndpoint[] = [];
  return {
    directory,
    root,
    server,
    async connect() {
      const endpoint = new FtpEndpoint(profile(server.port, secure));
      endpoints.push(endpoint);
      await endpoint.connect('test-password');
      return endpoint;
    },
    async close() {
      endpoints.forEach((endpoint) => endpoint.close());
      await server.close();
      await fs.rm(directory, { recursive: true, force: true });
    },
  };
}

test(
  'real FTP: browse, upload/download, remote streaming, rename, folders, missing and delete',
  { skip, timeout: 30000 },
  async () => {
    const a = await fixture();
    const b = await fixture();
    try {
      const source = await a.connect();
      const target = await b.connect();
      await source.mkdir('/folder');
      await source.write('/folder/café.txt', Readable.from('hello FTP'));
      assert.equal(await source.canonical('/folder'), '/folder');
      assert.equal((await source.list('/folder'))[0].name, 'café.txt');
      await copyFile(
        source,
        target,
        '/folder/café.txt',
        '/copy.txt',
        false,
        new AbortController().signal,
        () => {},
      );
      assert.equal(await fs.readFile(path.join(b.root, 'copy.txt'), 'utf8'), 'hello FTP');
      await copyFile(
        target,
        new LocalEndpoint(),
        '/copy.txt',
        path.join(a.directory, 'download.txt'),
        false,
        new AbortController().signal,
        () => {},
      );
      assert.equal(await fs.readFile(path.join(a.directory, 'download.txt'), 'utf8'), 'hello FTP');
      await source.rename('/folder/café.txt', '/renamed.txt', false);
      await source.remove('/folder', true);
      await source.remove('/renamed.txt', false);
      await assert.rejects(source.stat('/missing.txt'), { code: 'ENOENT' });
      assert.deepEqual(await source.list('/'), []);
    } finally {
      await a.close();
      await b.close();
    }
  },
);

test(
  'real FTP: explicit replacement preserves staged bytes and no-overwrite protects originals',
  { skip, timeout: 30000 },
  async () => {
    const f = await fixture();
    try {
      await fs.writeFile(path.join(f.root, 'a'), 'replacement');
      await fs.writeFile(path.join(f.root, 'b'), 'original');
      const source = await f.connect();
      const target = await f.connect();
      await assert.rejects(
        copyFile(source, target, '/a', '/b', false, new AbortController().signal, () => {}),
        /exists/,
      );
      assert.equal(await fs.readFile(path.join(f.root, 'b'), 'utf8'), 'original');
      const replacing = copyFile(
        source,
        target,
        '/a',
        '/b',
        true,
        new AbortController().signal,
        () => {},
      );
      if (process.platform === 'win32') {
        // pyftpdlib delegates rename to the host OS. Windows refuses replacement;
        // the client must keep the original, not delete it to force a save.
        await assert.rejects(replacing, /exists/i);
        assert.equal(await fs.readFile(path.join(f.root, 'b'), 'utf8'), 'original');
      } else {
        await replacing;
        assert.equal(await fs.readFile(path.join(f.root, 'b'), 'utf8'), 'replacement');
      }
      assert.deepEqual((await fs.readdir(f.root)).sort(), ['a', 'b']);
    } finally {
      await f.close();
    }
  },
);

test(
  'real FTP/SFTP interoperability: streamed transfer in both directions',
  { skip, timeout: 30000 },
  async () => {
    const ftp = await fixture();
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cosy-mixed-'));
    const server = await sftpServer(directory);
    const ssh = new SftpEndpoint({
      ...profile(server.port),
      protocol: 'sftp',
      allowInsecure: false,
    });
    try {
      const buffer = randomBytes(256 * 1024);
      await fs.writeFile(path.join(ftp.root, 'binary'), buffer);
      const endpoint = await ftp.connect();
      await ssh.connect('test-password', async () => true);
      await copyFile(
        endpoint,
        ssh,
        '/binary',
        '/sftp-copy',
        false,
        new AbortController().signal,
        () => {},
      );
      await copyFile(
        ssh,
        endpoint,
        '/sftp-copy',
        '/back',
        false,
        new AbortController().signal,
        () => {},
      );
      assert.deepEqual(await fs.readFile(path.join(directory, 'sftp-copy')), buffer);
      assert.deepEqual(await fs.readFile(path.join(ftp.root, 'back')), buffer);
    } finally {
      ssh.close();
      await server.close();
      await ftp.close();
      await fs.rm(directory, { force: true, recursive: true });
    }
  },
);

test(
  'real FTP: recursive uploads preflight missing destination parents safely',
  { skip, timeout: 30000 },
  async () => {
    const f = await fixture();
    try {
      const local = path.join(f.directory, 'local');
      await fs.mkdir(path.join(local, 'tree', 'nested', 'empty'), { recursive: true });
      await fs.writeFile(path.join(local, 'tree', 'nested', 'café.txt'), 'nested upload');
      const queue = new TransferQueue(
        async (id) => (id === 'local' ? new LocalEndpoint() : f.connect()),
        () => {},
      );
      const queued = queue.add({
        source: { sessionId: 'local', path: local },
        destination: { sessionId: 'remote', path: '/' },
        names: ['tree'],
        overwrite: false,
        move: false,
      });
      for (let i = 0; i < 2000 && ['queued', 'running'].includes(queue.list()[0].state); i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      const result = queue.list().find((job) => job.id === queued.id)!;
      assert.equal(result.state, 'completed', result.error);
      assert.equal(result.files, 1);
      assert.equal(
        await fs.readFile(path.join(f.root, 'tree', 'nested', 'café.txt'), 'utf8'),
        'nested upload',
      );
      assert.equal(
        (await fs.stat(path.join(f.root, 'tree', 'nested', 'empty'))).isDirectory(),
        true,
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'real FTPS: untrusted certificates are rejected; trusted TLS transfers work; wrong hostname is rejected',
  { skip, timeout: 30000 },
  async () => {
    const f = await fixture(true);
    const previous = tls.getCACertificates();
    const untrusted = new FtpEndpoint(profile(f.server.port, true));
    const mismatch = new FtpEndpoint({ ...profile(f.server.port, true), host: '127.0.0.1' });
    try {
      await assert.rejects(untrusted.connect('test-password'), /certificate|self.signed/i);
      untrusted.close();
      tls.setDefaultCACertificates([...previous, await fs.readFile(f.server.certificate!, 'utf8')]);
      const endpoint = await f.connect();
      await endpoint.write('/secure.txt', Readable.from('over TLS'));
      await copyFile(
        endpoint,
        new LocalEndpoint(),
        '/secure.txt',
        path.join(f.directory, 'download.txt'),
        false,
        new AbortController().signal,
        () => {},
      );
      assert.equal(await fs.readFile(path.join(f.directory, 'download.txt'), 'utf8'), 'over TLS');
      await assert.rejects(mismatch.connect('test-password'), /hostname|altname|IP.*cert/i);
    } finally {
      tls.setDefaultCACertificates(previous);
      untrusted.close();
      mismatch.close();
      await f.close();
    }
  },
);
