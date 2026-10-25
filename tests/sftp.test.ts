import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { SftpEndpoint, LocalEndpoint } from '../electron/endpoints';
import { copyFile, TransferQueue } from '../electron/transfers';
import { sftpServer } from './fixtures/sftp-server';
import type { Profile } from '../shared/types';

function profile(port: number): Profile {
  return {
    id: 'test',
    name: 'Loopback SFTP',
    protocol: 'sftp',
    host: '127.0.0.1',
    port,
    username: 'tester',
    initialPath: '/',
    hasPassword: false,
    allowInsecure: false,
  };
}
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cosy-sftp-'));
  const server = await sftpServer(root);
  const endpoints: SftpEndpoint[] = [];
  async function connect() {
    const endpoint = new SftpEndpoint(profile(server.port));
    endpoints.push(endpoint);
    await endpoint.connect('test-password', async () => true);
    return endpoint;
  }
  return {
    root,
    server,
    connect,
    async close() {
      endpoints.forEach((endpoint) => endpoint.close());
      await server.close();
      await fs.rm(root, { force: true, recursive: true });
    },
  };
}

test(
  'real SFTP: list, canonical path, write/read, rename, folders and delete',
  { timeout: 20000 },
  async () => {
    const f = await fixture();
    try {
      const endpoint = await f.connect();
      assert.equal(await endpoint.canonical('/'), '/');
      await endpoint.mkdir('/folder');
      await endpoint.write('/folder/café.txt', Readable.from('hello world'));
      const listing = await endpoint.list('/folder');
      assert.equal(listing[0].kind, 'file');
      assert.equal(listing[0].size, 11);
      assert.equal(listing[0].name, 'café.txt');
      let content = '';
      await endpoint.read(
        '/folder/café.txt',
        new Writable({
          write(chunk, _encoding, callback) {
            content += chunk.toString();
            callback();
          },
        }),
      );
      assert.equal(content, 'hello world');
      await endpoint.rename('/folder/café.txt', '/folder/renamed.txt', false);
      await assert.rejects(endpoint.stat('/folder/café.txt'), { code: 2 });
      await endpoint.remove('/folder/renamed.txt', false);
      await endpoint.remove('/folder', true);
      assert.deepEqual(await endpoint.list('/'), []);
    } finally {
      await f.close();
    }
  },
);

test(
  'real SFTP: local upload, download and streamed remote-to-remote copy preserve binary content',
  { timeout: 30000 },
  async () => {
    const a = await fixture();
    const b = await fixture();
    try {
      const buffer = randomBytes(512 * 1024);
      await fs.writeFile(path.join(a.root, 'local.bin'), buffer);
      const source = await a.connect();
      const target = await b.connect();
      await copyFile(
        new LocalEndpoint(),
        source,
        path.join(a.root, 'local.bin'),
        '/upload.bin',
        false,
        new AbortController().signal,
        () => {},
      );
      await copyFile(
        source,
        target,
        '/upload.bin',
        '/remote.bin',
        false,
        new AbortController().signal,
        () => {},
      );
      assert.deepEqual(await fs.readFile(path.join(b.root, 'remote.bin')), buffer);
      await copyFile(
        target,
        new LocalEndpoint(),
        '/remote.bin',
        path.join(a.root, 'download.bin'),
        false,
        new AbortController().signal,
        () => {},
      );
      assert.deepEqual(await fs.readFile(path.join(a.root, 'download.bin')), buffer);
    } finally {
      await a.close();
      await b.close();
    }
  },
);

test(
  'real SFTP: refused host keys and incorrect passwords cannot establish sessions',
  { timeout: 20000 },
  async () => {
    const f = await fixture();
    const endpoint = new SftpEndpoint(profile(f.server.port));
    const wrong = new SftpEndpoint(profile(f.server.port));
    try {
      let fingerprint = '';
      await assert.rejects(
        endpoint.connect('test-password', async (_host, received) => {
          fingerprint = received;
          return false;
        }),
        /verification|verify|key/i,
      );
      assert.match(fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/);
      await assert.rejects(
        wrong.connect('incorrect', async () => true),
        /authentication/i,
      );
    } finally {
      endpoint.close();
      wrong.close();
      await f.close();
    }
  },
);

test(
  'real SFTP: no-overwrite and unsupported atomic replacement preserve the existing file',
  { timeout: 20000 },
  async () => {
    const f = await fixture();
    try {
      await fs.writeFile(path.join(f.root, 'a'), 'new');
      await fs.writeFile(path.join(f.root, 'b'), 'original');
      const source = await f.connect();
      const target = await f.connect();
      await assert.rejects(
        copyFile(source, target, '/a', '/b', false, new AbortController().signal, () => {}),
        /exists/,
      );
      await assert.rejects(
        copyFile(source, target, '/a', '/b', true, new AbortController().signal, () => {}),
      );
      assert.equal(await fs.readFile(path.join(f.root, 'b'), 'utf8'), 'original');
      assert.deepEqual((await fs.readdir(f.root)).sort(), ['a', 'b']);
    } finally {
      await f.close();
    }
  },
);

test(
  'real SFTP: queue uses server-side rename for same-server moves',
  { timeout: 20000 },
  async () => {
    const f = await fixture();
    try {
      await fs.writeFile(path.join(f.root, 'a'), 'move me');
      await fs.mkdir(path.join(f.root, 'folder'));
      const queue = new TransferQueue(
        () => f.connect(),
        () => {},
      );
      const queued = queue.add({
        source: { sessionId: 'a', path: '/' },
        destination: { sessionId: 'b', path: '/folder' },
        names: ['a'],
        overwrite: false,
        move: true,
      });
      for (let i = 0; i < 1000; i++) {
        if (!['queued', 'running'].includes(queue.list()[0].state)) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const result = queue.list().find((job) => job.id === queued.id)!;
      assert.equal(result.state, 'completed', result.error);
      assert.equal(result.mode, 'Moving on server');
      assert.equal(result.bytes, 0);
      assert.equal(await fs.readFile(path.join(f.root, 'folder', 'a'), 'utf8'), 'move me');
    } finally {
      await f.close();
    }
  },
);
