import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Sessions } from '../electron/sessions';
import { EditorService } from '../electron/editor';
import { pythonServer } from './fixtures/ftp-server';
import type { Profile } from '../shared/types';

const skip =
  process.env.COSY_PROTOCOL_TESTS !== '1'
    ? 'Set COSY_PROTOCOL_TESTS=1 after installing tests/requirements.txt'
    : false;

test(
  'independent SFTP implementation: explicit editor save, POSIX replacement, draft recovery and conflict protection',
  { skip, timeout: 30000 },
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cosy-paramiko-'));
    const root = path.join(directory, 'server');
    await fs.mkdir(root);
    const server = await pythonServer('paramiko-server.py', root);
    const sessions = new Sessions(async () => true);
    const saved: Profile = {
      id: 'independent',
      name: 'Independent SFTP',
      protocol: 'sftp',
      host: '127.0.0.1',
      port: server.port,
      username: 'tester',
      initialPath: '/',
      allowInsecure: false,
      hasPassword: false,
    };
    try {
      const file = path.join(root, 'config.txt');
      await fs.writeFile(file, 'original\r\n');
      await fs.chmod(file, 0o640);
      const initialMode = (await fs.stat(file)).mode & 0o777;
      const session = await sessions.create(saved, 'test-password');
      const editor = new EditorService(path.join(directory, 'recovery'), sessions);
      await editor.load();
      const document = await editor.open({ sessionId: session.id, path: '/config.txt' });
      await editor.draft(document.id, 'edited\r\n');
      assert.equal(await fs.readFile(file, 'utf8'), 'original\r\n');
      const uploaded = await editor.upload(document.id);
      assert.equal(uploaded.status, 'Saved to server');
      assert.equal(uploaded.dirty, false);
      assert.equal(await fs.readFile(file, 'utf8'), 'edited\r\n');
      assert.equal((await fs.stat(file)).mode & 0o777, initialMode);
      await editor.draft(document.id, 'recovered draft');
      sessions.disconnect(session.id);
      await assert.rejects(editor.upload(document.id), /disconnected/);
      const recovered = new EditorService(path.join(directory, 'recovery'), sessions);
      await recovered.load();
      assert.equal(recovered.list()[0].content, 'recovered draft');
      const reconnected = await sessions.create(saved, 'test-password');
      await recovered.rebind(document.id, reconnected.id);
      await fs.writeFile(file, 'changed elsewhere');
      await assert.rejects(recovered.upload(document.id), /changed/);
      assert.equal(await fs.readFile(file, 'utf8'), 'changed elsewhere');
      assert.equal(recovered.list()[0].content, 'recovered draft');
      assert.deepEqual(await fs.readdir(root), ['config.txt']);
      const compared = await recovered.compare(document.id);
      assert.equal(compared.changed, true);
      assert.equal(compared.content, 'changed elsewhere');
      await recovered.draft(document.id, 'merged remote draft');
      await recovered.review(document.id, compared.revision);
      assert.equal(await fs.readFile(file, 'utf8'), 'changed elsewhere');
      assert.equal((await recovered.upload(document.id)).status, 'Saved to server');
      assert.equal(await fs.readFile(file, 'utf8'), 'merged remote draft');
    } finally {
      sessions.close();
      await server.close();
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
);
