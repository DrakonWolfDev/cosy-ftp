import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { LocalEndpoint, SftpEndpoint } from '../electron/endpoints';
import { TransferQueue } from '../electron/transfers';
import { sftpServer } from '../tests/fixtures/sftp-server';
import type { Profile, TransferJob } from '../shared/types';

async function hash(file: string) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function main() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'cosy-stress-'));
  const local = path.join(root, 'local');
  const remoteA = path.join(root, 'server-a');
  const remoteB = path.join(root, 'server-b');
  for (const directory of [local, remoteA, remoteB]) await fsp.mkdir(directory);
  const a = await sftpServer(remoteA);
  const b = await sftpServer(remoteB);
  const baseline = process.memoryUsage().rss;
  let peak = baseline;
  const monitor = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss);
  }, 10);
  const started = Date.now();
  try {
    const file = await fsp.open(path.join(local, 'large.bin'), 'wx');
    const chunk = randomBytes(128 * 1024);
    try {
      for (let i = 0; i < 1024; i++) await file.write(chunk);
    } finally {
      await file.close();
    }
    for (let folder = 0; folder < 20; folder++) {
      const directory = path.join(local, 'tree', `folder-${folder}`);
      await fsp.mkdir(directory, { recursive: true });
      for (let i = 0; i < 50; i++)
        await fsp.writeFile(path.join(directory, `file-${i}.txt`), `folder ${folder}, file ${i}\n`);
    }
    const connect = async (port: number) => {
      const profile: Profile = {
        id: String(port),
        name: 'Stress fixture',
        protocol: 'sftp',
        host: '127.0.0.1',
        port,
        username: 'tester',
        initialPath: '/',
        hasPassword: false,
        allowInsecure: false,
      };
      const endpoint = new SftpEndpoint(profile);
      await endpoint.connect('test-password', async () => true);
      return endpoint;
    };
    const queue = new TransferQueue(
      (id) =>
        id === 'local'
          ? Promise.resolve(new LocalEndpoint())
          : connect(id === 'a' ? a.port : b.port),
      () => {},
    );
    const upload = queue.add({
      source: { sessionId: 'local', path: local },
      destination: { sessionId: 'a', path: '/' },
      names: ['large.bin', 'tree'],
      overwrite: false,
      move: false,
    });
    const relay = queue.add({
      source: { sessionId: 'a', path: '/' },
      destination: { sessionId: 'b', path: '/' },
      names: ['large.bin', 'tree'],
      overwrite: false,
      move: false,
    });
    const deadline = Date.now() + 180000;
    while (queue.active() && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(queue.active(), false, 'Stress transfer timed out');
    for (const job of queue.list()) {
      assert.equal(job.state, 'completed', job.error);
      assert.equal(job.files, 1001);
    }
    assert.equal(
      await hash(path.join(local, 'large.bin')),
      await hash(path.join(remoteB, 'large.bin')),
    );
    assert.equal(
      await fsp.readFile(path.join(remoteB, 'tree', 'folder-19', 'file-49.txt'), 'utf8'),
      'folder 19, file 49\n',
    );
    const report = {
      platform: process.platform,
      largeFileMiB: 128,
      smallFiles: 1000,
      operations: ['local upload', 'remote relay'],
      elapsedSeconds: (Date.now() - started) / 1000,
      processBaselineMiB: Math.round(baseline / 1048576),
      processPeakMiB: Math.round(peak / 1048576),
      jobs: queue
        .list()
        .map(({ label, state, files, bytes }: TransferJob) => ({ label, state, files, bytes })),
    };
    await fsp.mkdir('.test-artifacts', { recursive: true });
    await fsp.writeFile('.test-artifacts/stress.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    void upload;
    void relay;
  } finally {
    clearInterval(monitor);
    await a.close();
    await b.close();
    await fsp.rm(root, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
