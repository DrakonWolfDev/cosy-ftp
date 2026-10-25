import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Sessions } from '../electron/sessions';
import { sftpServer } from './fixtures/sftp-server';
import type { Profile } from '../shared/types';

test(
  'a dropped SFTP browsing session reconnects with its identity and last directory intact',
  { timeout: 20000 },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cosy-reconnect-'));
    await fs.mkdir(path.join(root, 'nested'));
    await fs.writeFile(path.join(root, 'nested', 'text.txt'), 'still here');
    let server = await sftpServer(root);
    const port = server.port;
    const sessions = new Sessions(async () => true);
    const profile: Profile = {
      id: 'saved',
      name: 'Reconnect fixture',
      protocol: 'sftp',
      host: '127.0.0.1',
      port: server.port,
      username: 'tester',
      initialPath: '/',
      hasPassword: false,
      allowInsecure: false,
    };
    try {
      const session = await sessions.create(profile, 'test-password');
      await sessions.browse({ sessionId: session.id, path: '/nested' });
      server.drop();
      await new Promise((resolve) => setTimeout(resolve, 50));
      await assert.rejects(sessions.browse({ sessionId: session.id, path: '/nested' }));
      const reconnected = await sessions.reconnect(session.id);
      assert.equal(reconnected.id, session.id);
      assert.equal(reconnected.path, '/nested');
      assert.equal(reconnected.profileId, 'saved');
      assert.equal(
        (await sessions.browse({ sessionId: session.id, path: '/nested' })).entries[0].name,
        'text.txt',
      );
      assert.equal(sessions.list().filter((item) => item.protocol === 'sftp').length, 1);
      await server.close();
      await assert.rejects(sessions.reconnect(session.id));
      assert.equal(
        sessions.list().find((item) => item.id === session.id)?.path,
        '/nested',
        'A failed reconnect must preserve the session and last path',
      );
      server = await sftpServer(root, { port });
      assert.equal((await sessions.reconnect(session.id)).id, session.id);
      assert.equal(
        (await sessions.browse({ sessionId: session.id, path: '/nested' })).entries[0].name,
        'text.txt',
      );
    } finally {
      sessions.close();
      await server.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
