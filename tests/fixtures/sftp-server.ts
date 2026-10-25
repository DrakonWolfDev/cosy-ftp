import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { Server, utils, type Connection, type SFTPWrapper, type Attributes } from 'ssh2';

const { STATUS_CODE: code, flagsToString } = utils.sftp;
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
export const hostKey = keys.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

export async function sftpServer(
  root: string,
  options: { key?: string; delayRead?: number; port?: number } = {},
) {
  const clients = new Set<Connection>();
  const server = new Server({ hostKeys: [options.key ?? hostKey] }, (client) => {
    clients.add(client);
    client.on('error', () => {});
    client.on('close', () => clients.delete(client));
    client.on('authentication', (context) => {
      if (
        context.method === 'password' &&
        context.username === 'tester' &&
        context.password === 'test-password'
      )
        context.accept();
      else context.reject(['password']);
    });
    client.on('ready', () =>
      client.on('session', (accept) => {
        const session = accept();
        session.on('sftp', (accept) => wire(accept(), root, options.delayRead ?? 0));
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (typeof address === 'string' || !address) throw new Error('No test server port');
  return {
    port: address.port,
    drop() {
      for (const client of clients) client.end();
    },
    async close() {
      for (const client of clients) client.end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function wire(sftp: SFTPWrapper, root: string, delayRead: number) {
  let next = 1;
  const handles = new Map<
    string,
    FileHandle | { entries: string[]; directory: string; read: boolean }
  >();
  const real = (file: string) => {
    const result = path.resolve(root, `.${path.posix.resolve('/', file)}`);
    const relative = path.relative(root, result);
    if (relative.startsWith('..') || path.isAbsolute(relative))
      throw new Error('Outside test root');
    return result;
  };
  const attrs = (stat: import('node:fs').Stats): Attributes => ({
    mode: stat.mode,
    uid: 0,
    gid: 0,
    size: stat.size,
    atime: Math.floor(stat.atimeMs / 1000),
    mtime: Math.floor(stat.mtimeMs / 1000),
  });
  const run = (req: number, task: () => Promise<void>) =>
    void task().catch((error: NodeJS.ErrnoException) => {
      sftp.status(
        req,
        error.code === 'ENOENT'
          ? code.NO_SUCH_FILE
          : error.code === 'EACCES' || error.code === 'EPERM'
            ? code.PERMISSION_DENIED
            : code.FAILURE,
      );
    });
  const newHandle = (
    item: FileHandle | { entries: string[]; directory: string; read: boolean },
  ) => {
    const handle = Buffer.alloc(4);
    handle.writeUInt32BE(next++);
    handles.set(handle.toString('hex'), item);
    return handle;
  };
  sftp.on('REALPATH', (req: number, file: string) =>
    run(req, async () => {
      await fs.stat(real(file));
      sftp.name(req, [
        { filename: path.posix.resolve('/', file), longname: '', attrs: {} as Attributes },
      ]);
    }),
  );
  for (const operation of ['STAT', 'LSTAT'] as const)
    sftp.on(operation, (req: number, file: string) =>
      run(req, async () => {
        sftp.attrs(req, attrs(await fs.lstat(real(file))));
      }),
    );
  sftp.on('OPENDIR', (req: number, directory: string) =>
    run(req, async () => {
      const entries = await fs.readdir(real(directory));
      sftp.handle(req, newHandle({ entries, directory, read: false }));
    }),
  );
  sftp.on('READDIR', (req: number, handle: Buffer) =>
    run(req, async () => {
      const item = handles.get(handle.toString('hex'));
      if (!item || 'fd' in item) throw new Error('Invalid directory handle');
      if (item.read) {
        sftp.status(req, code.EOF);
        return;
      }
      item.read = true;
      if (!item.entries.length) {
        sftp.status(req, code.EOF);
        return;
      }
      sftp.name(
        req,
        await Promise.all(
          item.entries.map(async (filename) => ({
            filename,
            longname: filename,
            attrs: attrs(await fs.lstat(real(path.posix.join(item.directory, filename)))),
          })),
        ),
      );
    }),
  );
  sftp.on('OPEN', (req: number, file: string, flags: number) =>
    run(req, async () => {
      const mode = flagsToString(flags);
      if (!mode) throw new Error('Bad open mode');
      sftp.handle(req, newHandle(await fs.open(real(file), mode, 0o600)));
    }),
  );
  sftp.on('READ', (req: number, handle: Buffer, offset: number, length: number) =>
    run(req, async () => {
      const item = handles.get(handle.toString('hex'));
      if (!item || !('fd' in item)) throw new Error('Invalid file handle');
      if (delayRead) await new Promise((resolve) => setTimeout(resolve, delayRead));
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await item.read(buffer, 0, length, offset);
      if (!bytesRead) sftp.status(req, code.EOF);
      else sftp.data(req, buffer.subarray(0, bytesRead));
    }),
  );
  sftp.on('WRITE', (req: number, handle: Buffer, offset: number, data: Buffer) =>
    run(req, async () => {
      const item = handles.get(handle.toString('hex'));
      if (!item || !('fd' in item)) throw new Error('Invalid file handle');
      await item.write(data, 0, data.length, offset);
      sftp.status(req, code.OK);
    }),
  );
  sftp.on('FSTAT', (req: number, handle: Buffer) =>
    run(req, async () => {
      const item = handles.get(handle.toString('hex'));
      if (!item || !('fd' in item)) throw new Error('Invalid file handle');
      sftp.attrs(req, attrs(await item.stat()));
    }),
  );
  sftp.on('CLOSE', (req: number, handle: Buffer) =>
    run(req, async () => {
      const item = handles.get(handle.toString('hex'));
      handles.delete(handle.toString('hex'));
      if (item && 'fd' in item) await item.close();
      sftp.status(req, code.OK);
    }),
  );
  sftp.on('MKDIR', (req: number, file: string) =>
    run(req, async () => {
      await fs.mkdir(real(file));
      sftp.status(req, code.OK);
    }),
  );
  sftp.on('SETSTAT', (req: number, file: string, values: Partial<Attributes>) =>
    run(req, async () => {
      if (values.mode !== undefined) await fs.chmod(real(file), values.mode & 0o777);
      sftp.status(req, code.OK);
    }),
  );
  sftp.on('REMOVE', (req: number, file: string) =>
    run(req, async () => {
      await fs.unlink(real(file));
      sftp.status(req, code.OK);
    }),
  );
  sftp.on('RMDIR', (req: number, file: string) =>
    run(req, async () => {
      await fs.rmdir(real(file));
      sftp.status(req, code.OK);
    }),
  );
  sftp.on('RENAME', (req: number, from: string, to: string) =>
    run(req, async () => {
      try {
        await fs.lstat(real(to));
        throw Object.assign(new Error('Exists'), { code: 'EEXIST' });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await fs.rename(real(from), real(to));
      sftp.status(req, code.OK);
    }),
  );
  sftp.on('EXTENDED', (req: number) => sftp.status(req, code.OP_UNSUPPORTED));
  sftp.on('error', () => {});
  sftp.on('close', () => {
    for (const item of handles.values()) if ('fd' in item) void item.close().catch(() => {});
    handles.clear();
  });
}
