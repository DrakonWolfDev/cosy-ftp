import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SftpEndpoint } from '../electron/endpoints';
import { TransferQueue } from '../electron/transfers';
import { sftpServer } from './fixtures/sftp-server';
import type { Profile } from '../shared/types';

for (const action of ['disconnect', 'cancel'] as const) {
  test(
    `remote relay ${action} preserves the original and cleans its staging file using a fresh connection`,
    { timeout: 20000 },
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cosy-network-'));
      const aRoot = path.join(root, 'a');
      const bRoot = path.join(root, 'b');
      await fs.mkdir(aRoot);
      await fs.mkdir(bRoot);
      const size = 4 * 1024 * 1024;
      await fs.writeFile(path.join(aRoot, 'large.bin'), Buffer.alloc(size, 42));
      await fs.writeFile(path.join(bRoot, 'large.bin'), 'original');
      const a = await sftpServer(aRoot, { delayRead: 10 });
      const b = await sftpServer(bRoot);
      let acted = false;
      let queuedId = '';
      const queue = new TransferQueue(
        async (id) => {
          const profile: Profile = {
            id,
            name: id,
            protocol: 'sftp',
            host: '127.0.0.1',
            port: id === 'a' ? a.port : b.port,
            username: 'tester',
            initialPath: '/',
            hasPassword: false,
            allowInsecure: false,
          };
          const endpoint = new SftpEndpoint(profile);
          await endpoint.connect('test-password', async () => true);
          return endpoint;
        },
        (jobs) => {
          const job = jobs[0];
          if (!acted && job.state === 'running' && job.bytes > 0) {
            acted = true;
            if (action === 'disconnect') a.drop();
            else queue.cancel(queuedId);
          }
        },
      );
      try {
        queuedId = queue.add({
          source: { sessionId: 'a', path: '/' },
          destination: { sessionId: 'b', path: '/' },
          names: ['large.bin'],
          overwrite: true,
          move: false,
        }).id;
        const deadline = Date.now() + 15000;
        while (queue.active() && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(queue.active(), false, 'The interrupted relay must finish cleanup promptly');
        assert.equal(acted, true);
        const result = queue.list()[0];
        assert.equal(result.state, action === 'disconnect' ? 'failed' : 'cancelled', result.error);
        assert.ok(result.bytes > 0 && result.bytes < size);
        assert.equal(await fs.readFile(path.join(bRoot, 'large.bin'), 'utf8'), 'original');
        assert.deepEqual(await fs.readdir(bRoot), ['large.bin']);
      } finally {
        queue.shutdown();
        await a.close();
        await b.close();
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );
}
