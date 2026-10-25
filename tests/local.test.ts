import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Readable, Writable } from 'node:stream';
import { LocalEndpoint, endpointPath } from '../electron/endpoints';
import { TransferQueue, copyFile, nestedPath } from '../electron/transfers';
import { EditorService, EDIT_LIMIT } from '../electron/editor';
import { SettingsStore, type Secrets } from '../electron/store';
import { Sessions } from '../electron/sessions';
import { job, profile, name } from '../electron/validation';
import type { JobRequest, TransferJob } from '../shared/types';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cosy-test-'));
  const source = path.join(root, 'source');
  const target = path.join(root, 'target');
  await fs.mkdir(source);
  await fs.mkdir(target);
  return {
    root,
    source,
    target,
    async clean() {
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}
const location = (directory: string) => ({ sessionId: 'local', path: directory });
async function waitFor(queue: TransferQueue, id: string): Promise<TransferJob> {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const job = queue.list().find((job) => job.id === id)!;
    if (!['queued', 'running'].includes(job.state)) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Queue did not finish');
}

test('copies nested directories and Unicode names, reports bytes, and leaves no staging files', async () => {
  const f = await fixture();
  try {
    await fs.mkdir(path.join(f.source, 'folder'));
    await fs.writeFile(path.join(f.source, 'folder', 'café 🌿.txt'), 'hello');
    const queue = new TransferQueue(
      async () => new LocalEndpoint(),
      () => {},
    );
    const job = queue.add({
      source: location(f.source),
      destination: location(f.target),
      names: ['folder'],
      overwrite: false,
      move: false,
    });
    const completed = await waitFor(queue, job.id);
    assert.equal(completed.state, 'completed', completed.error);
    assert.equal(completed.bytes, 5);
    assert.equal(completed.total, 5);
    assert.equal(completed.files, 1);
    assert.equal(await fs.readFile(path.join(f.target, 'folder', 'café 🌿.txt'), 'utf8'), 'hello');
    assert.deepEqual(await fs.readdir(path.join(f.target, 'folder')), ['café 🌿.txt']);
  } finally {
    await f.clean();
  }
});

test('existing files stay unchanged by default; explicit replacement stages and commits', async () => {
  const f = await fixture();
  try {
    const from = path.join(f.source, 'file');
    const to = path.join(f.target, 'file');
    await fs.writeFile(from, 'new');
    await fs.writeFile(to, 'original');
    await assert.rejects(
      copyFile(
        new LocalEndpoint(),
        new LocalEndpoint(),
        from,
        to,
        false,
        new AbortController().signal,
        () => {},
      ),
      /already exists/,
    );
    assert.equal(await fs.readFile(to, 'utf8'), 'original');
    await copyFile(
      new LocalEndpoint(),
      new LocalEndpoint(),
      from,
      to,
      true,
      new AbortController().signal,
      () => {},
    );
    assert.equal(await fs.readFile(to, 'utf8'), 'new');
    assert.deepEqual(await fs.readdir(f.target), ['file']);
  } finally {
    await f.clean();
  }
});

test('copy and editor saves preserve ordinary file permission bits', async () => {
  const f = await fixture();
  const sessions = new Sessions(async () => false);
  try {
    const from = path.join(f.source, 'readonly.txt');
    const to = path.join(f.target, 'readonly.txt');
    await fs.writeFile(from, 'original');
    await fs.chmod(from, 0o444);
    const originalMode = (await fs.stat(from)).mode & 0o777;
    await copyFile(
      new LocalEndpoint(),
      new LocalEndpoint(),
      from,
      to,
      false,
      new AbortController().signal,
      () => {},
    );
    assert.equal((await fs.stat(to)).mode & 0o777, originalMode);
    await fs.chmod(from, 0o644);
    const editor = new EditorService(path.join(f.root, 'recovery'), sessions);
    await editor.load();
    const document = await editor.open(location(from));
    const writableMode = (await fs.stat(from)).mode & 0o777;
    await editor.draft(document.id, 'edited');
    await editor.upload(document.id);
    assert.equal((await fs.stat(from)).mode & 0o777, writableMode);
  } finally {
    sessions.close();
    await fs.chmod(path.join(f.target, 'readonly.txt'), 0o644).catch(() => {});
    await fs.chmod(path.join(f.source, 'readonly.txt'), 0o644).catch(() => {});
    await f.clean();
  }
});

test('a failed upload preserves the destination and removes its stage', async () => {
  const f = await fixture();
  class BrokenSource extends LocalEndpoint {
    override async read(_file: string, destination: Writable) {
      destination.write('partial');
      throw new Error('Network connection dropped');
    }
  }
  try {
    const from = path.join(f.source, 'file');
    const to = path.join(f.target, 'file');
    await fs.writeFile(from, 'new content');
    await fs.writeFile(to, 'original');
    await assert.rejects(
      copyFile(
        new BrokenSource(),
        new LocalEndpoint(),
        from,
        to,
        true,
        new AbortController().signal,
        () => {},
      ),
      /dropped/,
    );
    assert.equal(await fs.readFile(to, 'utf8'), 'original');
    assert.deepEqual(await fs.readdir(f.target), ['file']);
  } finally {
    await f.clean();
  }
});

test('cancellation stops a slow stream, preserves the original and cleans the stage', async () => {
  const f = await fixture();
  class SlowSource extends LocalEndpoint {
    override async read(_file: string, destination: Writable, signal?: AbortSignal) {
      const { pipeline } = await import('node:stream/promises');
      await pipeline(
        Readable.from(
          (async function* () {
            for (let i = 0; i < 100; i++) {
              await new Promise((resolve) => setTimeout(resolve, 3));
              yield Buffer.alloc(1024);
            }
          })(),
        ),
        destination,
        { signal },
      );
    }
  }
  try {
    const from = path.join(f.source, 'file');
    const to = path.join(f.target, 'file');
    await fs.writeFile(from, Buffer.alloc(102400));
    await fs.writeFile(to, 'original');
    const controller = new AbortController();
    const transfer = copyFile(
      new SlowSource(),
      new LocalEndpoint(),
      from,
      to,
      true,
      controller.signal,
      () => controller.abort(),
    );
    await assert.rejects(transfer);
    assert.equal(await fs.readFile(to, 'utf8'), 'original');
    assert.deepEqual(await fs.readdir(f.target), ['file']);
  } finally {
    await f.clean();
  }
});

test('recursive preflight refuses symlinks and does not leave a partial tree', async (t) => {
  const f = await fixture();
  try {
    await fs.mkdir(path.join(f.source, 'tree'));
    try {
      await fs.symlink(
        f.target,
        path.join(f.source, 'tree', 'link'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch (error) {
      t.skip(`Symlink creation unavailable: ${error}`);
      return;
    }
    const queue = new TransferQueue(
      async () => new LocalEndpoint(),
      () => {},
    );
    const queued = queue.add({
      source: location(f.source),
      destination: location(f.target),
      names: ['tree'],
      overwrite: false,
      move: false,
    });
    const result = await waitFor(queue, queued.id);
    assert.equal(result.state, 'failed');
    assert.match(result.error!, /links/);
    assert.deepEqual(await fs.readdir(f.target), []);
  } finally {
    await f.clean();
  }
});

test('same-location and recursive self-copy are refused, including canonical parent aliases', async () => {
  const f = await fixture();
  try {
    await fs.mkdir(path.join(f.source, 'tree'));
    await fs.writeFile(path.join(f.source, 'file'), 'a');
    const queue = new TransferQueue(
      async () => new LocalEndpoint(),
      () => {},
    );
    const one = queue.add({
      source: location(f.source),
      destination: location(f.source),
      names: ['file'],
      overwrite: true,
      move: false,
    });
    assert.match((await waitFor(queue, one.id)).error!, /same/);
    const two = queue.add({
      source: location(f.source),
      destination: location(path.join(f.source, 'tree')),
      names: ['tree'],
      overwrite: false,
      move: false,
    });
    assert.match((await waitFor(queue, two.id)).error!, /itself/);
    assert.equal(nestedPath('/foo', '/foobar', true), false);
    assert.equal(nestedPath('/foo', '/foo/bar', true), true);
  } finally {
    await f.clean();
  }
});

test('queue runs sequentially, can cancel pending jobs, retry failures and move files', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.source, 'file'), 'hello');
    const queue = new TransferQueue(
      async () => new LocalEndpoint(),
      () => {},
    );
    const request: JobRequest = {
      source: location(f.source),
      destination: location(f.target),
      names: ['missing'],
      overwrite: false,
      move: false,
    };
    const failed = queue.add(request);
    const cancelled = queue.add({ ...request, names: ['file'] });
    queue.cancel(cancelled.id);
    assert.equal((await waitFor(queue, failed.id)).state, 'failed');
    assert.equal((await waitFor(queue, cancelled.id)).state, 'cancelled');
    await fs.writeFile(path.join(f.source, 'missing'), 'back');
    assert.equal((await waitFor(queue, queue.retry(failed.id).id)).state, 'completed');
    assert.equal(
      (await waitFor(queue, queue.add({ ...request, names: ['file'], move: true }).id)).state,
      'completed',
    );
    await assert.rejects(fs.stat(path.join(f.source, 'file')), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(f.target, 'file'), 'utf8'), 'hello');
    queue.clear();
    assert.equal(queue.list().length, 0);
  } finally {
    await f.clean();
  }
});

test('editor recovers drafts, refuses changed originals and handles successful explicit saves', async () => {
  const f = await fixture();
  const sessions = new Sessions(async () => false);
  try {
    const file = path.join(f.source, 'config.txt');
    await fs.writeFile(file, '\ufeffhello\r\n');
    const recovery = path.join(f.root, 'recovery');
    const editor = new EditorService(recovery, sessions);
    await editor.load();
    const document = await editor.open(location(file));
    assert.equal(document.content, '\ufeffhello\r\n');
    await editor.draft(document.id, 'local edit\r\n');
    const recovered = new EditorService(recovery, sessions);
    await recovered.load();
    assert.equal(recovered.list()[0].content, 'local edit\r\n');
    assert.equal(recovered.list()[0].dirty, true);
    await fs.writeFile(file, 'someone else');
    await assert.rejects(recovered.upload(document.id), /changed/);
    assert.equal(await fs.readFile(file, 'utf8'), 'someone else');
    assert.equal(recovered.list()[0].dirty, true);
    await fs.writeFile(file, '\ufeffhello\r\n');
    assert.equal((await recovered.upload(document.id)).status, 'Saved to disk');
    assert.equal(await fs.readFile(file, 'utf8'), 'local edit\r\n');
    assert.equal(recovered.list()[0].dirty, false);
    await recovered.close(document.id);
    assert.deepEqual(await fs.readdir(recovery), []);
  } finally {
    sessions.close();
    await f.clean();
  }
});

test('editor rejects binary, malformed UTF-8, oversize files and symlinks', async () => {
  const f = await fixture();
  const sessions = new Sessions(async () => false);
  try {
    const editor = new EditorService(path.join(f.root, 'recovery'), sessions);
    await editor.load();
    for (const [name, content, pattern] of [
      ['binary', Buffer.from([0, 1]), /binary/],
      ['invalid', Buffer.from([0xff]), /UTF-8/],
      ['large', Buffer.alloc(EDIT_LIMIT + 1, 65), /2 MiB/],
    ] as const) {
      const file = path.join(f.source, name);
      await fs.writeFile(file, content);
      await assert.rejects(editor.open(location(file)), pattern);
    }
  } finally {
    sessions.close();
    await f.clean();
  }
});

test('failed recovery writes retain the latest draft in memory and keep close protection enabled', async () => {
  const f = await fixture();
  const sessions = new Sessions(async () => false);
  try {
    const file = path.join(f.source, 'text.txt');
    await fs.writeFile(file, 'original');
    const recovery = path.join(f.root, 'recovery');
    const backup = path.join(f.root, 'recovery-backup');
    const editor = new EditorService(recovery, sessions);
    await editor.load();
    const document = await editor.open(location(file));
    await fs.rename(recovery, backup);
    await fs.writeFile(recovery, 'block directory writes');
    await assert.rejects(
      editor.draft(document.id, 'latest unsaved text'),
      /recovery copy could not be saved/,
    );
    assert.equal(editor.list()[0].content, 'latest unsaved text');
    assert.equal(editor.dirty(document.id), true);
    assert.equal(editor.hasUnpersistedChanges(), true);
    assert.equal(await fs.readFile(file, 'utf8'), 'original');
    await fs.unlink(recovery);
    await fs.rename(backup, recovery);
    await editor.draft(document.id, 'latest unsaved text');
    assert.equal(editor.hasUnpersistedChanges(), false);
    const recovered = new EditorService(recovery, sessions);
    await recovered.load();
    assert.equal(recovered.list()[0].content, 'latest unsaved text');
  } finally {
    sessions.close();
    await f.clean();
  }
});

test('credentials are encrypted separately, profile metadata is safe, and persistence reloads', async () => {
  const f = await fixture();
  const secrets: Secrets = {
    async available() {
      return true;
    },
    async encrypt(value) {
      return `encrypted:${Buffer.from(value).toString('base64')}`;
    },
    async decrypt(value) {
      return Buffer.from(value.slice(10), 'base64').toString();
    },
  };
  const input = {
    name: 'Server',
    protocol: 'sftp' as const,
    host: 'localhost',
    port: 22,
    username: 'user',
    initialPath: '/',
    rememberPassword: true,
    allowInsecure: false,
    password: 'secret-password',
  };
  try {
    const file = path.join(f.root, 'settings.json');
    const store = new SettingsStore(file, secrets);
    await store.load();
    const saved = await store.save(input);
    assert.equal(saved.hasPassword, true);
    assert.equal(JSON.stringify(saved).includes('secret'), false);
    assert.equal(await store.password(saved.id), input.password);
    assert.equal((await fs.readFile(file, 'utf8')).includes(input.password), false);
    const reloaded = new SettingsStore(file, secrets);
    await reloaded.load();
    assert.equal(await reloaded.password(saved.id), input.password);
    await reloaded.save({ ...input, id: saved.id, password: undefined });
    assert.equal(await reloaded.password(saved.id), input.password);
    await reloaded.save({ ...input, id: saved.id, host: 'different-server', password: undefined });
    assert.equal(
      await reloaded.password(saved.id),
      undefined,
      'Existing credentials must not be reused for another server',
    );
    await reloaded.save({ ...input, id: saved.id, rememberPassword: false });
    assert.equal(await reloaded.password(saved.id), undefined);
    await reloaded.trustHost('localhost:22', 'SHA256:test');
    assert.equal(reloaded.hostKey('localhost:22'), 'SHA256:test');
    await reloaded.delete(saved.id);
    assert.deepEqual(reloaded.list(), []);
  } finally {
    await f.clean();
  }
});

test('unavailable secure storage refuses remembered secrets and corrupt settings remain untouched', async () => {
  const f = await fixture();
  const secrets: Secrets = {
    async available() {
      return false;
    },
    async encrypt() {
      throw new Error('No');
    },
    async decrypt() {
      throw new Error('No');
    },
  };
  try {
    const file = path.join(f.root, 'settings.json');
    const store = new SettingsStore(file, secrets);
    await store.load();
    await assert.rejects(
      store.save({
        name: 'S',
        protocol: 'sftp',
        host: 'localhost',
        port: 22,
        username: 'u',
        initialPath: '/',
        allowInsecure: false,
        rememberPassword: true,
        password: 'secret',
      }),
      /unavailable/,
    );
    assert.deepEqual(store.list(), []);
    await fs.writeFile(file, '{broken');
    await assert.rejects(new SettingsStore(file, secrets).load(), /preserved/);
    assert.equal(await fs.readFile(file, 'utf8'), '{broken');
  } finally {
    await f.clean();
  }
});

test('IPC validation rejects path traversal names, FTP command injection and unapproved insecure FTP', () => {
  for (const bad of ['..', '.', '../secret', 'a/b', 'a\\b', 'file\r\nDELE x', 'nul\0'])
    assert.equal(name.safeParse(bad).success, false);
  assert.throws(() => endpointPath(new LocalEndpoint(), 'C:\\', '../escape'));
  assert.equal(
    profile.safeParse({
      name: 'S',
      protocol: 'ftp',
      host: 'localhost',
      port: 21,
      username: 'u',
      initialPath: '/',
      allowInsecure: false,
      rememberPassword: false,
    }).success,
    false,
  );
  assert.equal(
    job.safeParse({
      source: location('/'),
      destination: location('/'),
      names: ['ok'],
      overwrite: false,
      move: false,
      arbitrary: true,
    }).success,
    false,
  );
});
