import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import type { Readable, Writable } from 'node:stream';
import { Client as FtpClient, FTPError } from 'basic-ftp';
import { Client as SshClient, type SFTPWrapper, type Stats, type Attributes } from 'ssh2';
import type { Entry, Profile } from '../shared/types';
import { ftpsCertificateError } from './tls-errors';

export interface Endpoint {
  readonly remote: boolean;
  readonly identity: string;
  list(directory: string): Promise<Entry[]>;
  stat(file: string): Promise<Entry>;
  canonical(directory: string): Promise<string>;
  mkdir(directory: string): Promise<void>;
  rename(from: string, to: string, replace: boolean): Promise<void>;
  remove(file: string, directory: boolean): Promise<void>;
  read(file: string, destination: Writable, signal?: AbortSignal): Promise<void>;
  write(file: string, source: Readable, signal?: AbortSignal): Promise<void>;
  setMode?(file: string, mode: number): Promise<void>;
  close(): void;
}

export function endpointPath(endpoint: Endpoint, directory: string, name: string) {
  if (!name || name === '.' || name === '..' || /[\\/\0\r\n]/.test(name))
    throw new Error('Unsafe filename in directory listing');
  if (
    !endpoint.remote &&
    process.platform === 'win32' &&
    (/[<>:"|?*]/.test(name) ||
      /[. ]$/.test(name) ||
      /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name))
  )
    throw new Error(`Filename cannot be represented safely on Windows: ${name}`);
  return endpoint.remote ? path.posix.join(directory, name) : path.join(directory, name);
}
export function notFound(error: unknown): boolean {
  const code = (error as { code?: string | number }).code;
  return code === 'ENOENT' || code === 2;
}
export async function exists(endpoint: Endpoint, file: string): Promise<boolean> {
  try {
    await endpoint.stat(file);
    return true;
  } catch (error) {
    if (notFound(error)) return false;
    throw error;
  }
}
async function timedPipeline(source: Readable, destination: Writable, signal?: AbortSignal) {
  const idle = new AbortController();
  let timer = setTimeout(
    () => idle.abort(new Error('No file data received for 30 seconds. Reconnect and retry.')),
    30000,
  );
  const reset = () => {
    clearTimeout(timer);
    timer = setTimeout(
      () => idle.abort(new Error('No file data received for 30 seconds. Reconnect and retry.')),
      30000,
    );
  };
  source.on('data', reset);
  try {
    await pipeline(source, destination, {
      signal: signal ? AbortSignal.any([signal, idle.signal]) : idle.signal,
    });
  } catch (error) {
    if (idle.signal.aborted) throw idle.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    source.off('data', reset);
  }
}
function localEntry(file: string, stat: fs.Stats): Entry {
  return {
    name: path.basename(file),
    path: file,
    kind: stat.isSymbolicLink()
      ? 'link'
      : stat.isDirectory()
        ? 'directory'
        : stat.isFile()
          ? 'file'
          : 'other',
    size: stat.size,
    modified: stat.mtimeMs,
    mode: stat.mode & 0o777,
  };
}

export class LocalEndpoint implements Endpoint {
  readonly remote = false;
  readonly identity = 'local';
  async list(directory: string) {
    const dirents = await fsp.readdir(directory, { withFileTypes: true });
    // Bound metadata calls rather than opening thousands of handles at once.
    const entries: Entry[] = [];
    for (let i = 0; i < dirents.length; i += 64) {
      entries.push(
        ...(await Promise.all(
          dirents.slice(i, i + 64).map(async (item) => {
            const file = path.join(directory, item.name);
            try {
              return await this.stat(file);
            } catch {
              return {
                name: item.name,
                path: file,
                kind: item.isDirectory() ? 'directory' : 'other',
                size: 0,
                modified: null,
              } as Entry;
            }
          }),
        )),
      );
    }
    return entries;
  }
  async stat(file: string) {
    return localEntry(file, await fsp.lstat(file));
  }
  canonical(directory: string) {
    return fsp.realpath(directory);
  }
  async mkdir(directory: string) {
    await fsp.mkdir(directory);
  }
  async rename(from: string, to: string, replace: boolean) {
    if (!replace && (await exists(this, to))) throw new Error('Destination already exists');
    // Hard-link commit is exclusive for staged regular files; rename handles directories/moves.
    if (!replace && (await this.stat(from)).kind === 'file') {
      await fsp.link(from, to);
      await fsp.unlink(from);
    } else await fsp.rename(from, to);
  }
  async remove(file: string, directory: boolean) {
    if (directory) await fsp.rmdir(file);
    else await fsp.unlink(file);
  }
  async read(file: string, destination: Writable, signal?: AbortSignal) {
    await pipeline(fs.createReadStream(file), destination, { signal });
  }
  async write(file: string, source: Readable, signal?: AbortSignal) {
    await pipeline(source, fs.createWriteStream(file, { flags: 'wx', mode: 0o600 }), { signal });
  }
  async setMode(file: string, mode: number) {
    await fsp.chmod(file, mode & 0o777);
  }
  close() {}
}

export type HostVerifier = (host: string, fingerprint: string) => Promise<boolean>;
export function profileIdentity(profile: Profile) {
  return JSON.stringify([
    profile.protocol,
    profile.host.toLowerCase(),
    profile.port,
    profile.username,
  ]);
}

export class SftpEndpoint implements Endpoint {
  readonly remote = true;
  readonly identity: string;
  private client = new SshClient();
  private sftp!: SFTPWrapper;
  private failure?: Error;
  constructor(private profile: Profile) {
    this.identity = profileIdentity(profile);
  }
  async connect(password: string | undefined, verify: HostVerifier) {
    await new Promise<void>((resolve, reject) => {
      this.client.on('error', (error) => {
        this.failure = error;
        reject(error);
      });
      this.client.once('close', () => {
        this.failure ??= new Error('SFTP connection closed. Reconnect and retry.');
        reject(this.failure);
      });
      this.client.once('ready', () =>
        this.client.sftp((error, sftp) => {
          if (error) reject(error);
          else {
            this.sftp = sftp;
            resolve();
          }
        }),
      );
      this.client.connect({
        host: this.profile.host,
        port: this.profile.port,
        username: this.profile.username,
        password,
        readyTimeout: 20000,
        keepaliveInterval: 15000,
        keepaliveCountMax: 3,
        hostVerifier: (key: Buffer, callback: (valid: boolean) => void) => {
          const fingerprint = `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
          verify(`${this.profile.host.toLowerCase()}:${this.profile.port}`, fingerprint).then(
            callback,
            () => callback(false),
          );
        },
      });
    });
  }
  private call<T>(
    operation: (callback: (error: Error | undefined | null, value: T) => void) => void,
  ): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.close();
        reject(
          new Error('The SFTP server did not respond within 30 seconds. Reconnect and retry.'),
        );
      }, 30000);
      try {
        operation((error, value) => {
          clearTimeout(timer);
          error ? reject(error) : resolve(value);
        });
      } catch (error) {
        clearTimeout(timer);
        reject(error);
      }
    });
  }
  private entry(file: string, attrs: Attributes): Entry {
    const type = attrs.mode & 0o170000;
    return {
      name: path.posix.basename(file),
      path: file,
      kind:
        type === 0o120000
          ? 'link'
          : type === 0o040000
            ? 'directory'
            : type === 0o100000
              ? 'file'
              : 'other',
      size: attrs.size,
      modified: attrs.mtime * 1000,
      mode: attrs.mode & 0o777,
    };
  }
  async list(directory: string) {
    const items = await this.call<import('ssh2').FileEntry[]>((cb) =>
      this.sftp.readdir(directory, cb),
    );
    return items
      .filter((item) => item.filename !== '.' && item.filename !== '..')
      .map((item) => this.entry(endpointPath(this, directory, item.filename), item.attrs));
  }
  async stat(file: string) {
    return this.entry(file, await this.call<Stats>((cb) => this.sftp.lstat(file, cb)));
  }
  canonical(directory: string) {
    return this.call<string>((cb) => this.sftp.realpath(directory, cb));
  }
  async mkdir(directory: string) {
    await this.call<void>((cb) => this.sftp.mkdir(directory, cb));
  }
  async rename(from: string, to: string, replace: boolean) {
    if (!replace && (await exists(this, to))) throw new Error('Destination already exists');
    // Standard SFTP v3 rename must fail if the destination exists. Only use the
    // POSIX replacement extension when overwrite was explicitly requested.
    if (replace) {
      try {
        await this.call<void>((cb) => this.sftp.ext_openssh_rename(from, to, cb));
        return;
      } catch (error) {
        if (
          (error as { code?: number }).code !== 8 &&
          !(error as Error).message.includes('does not support')
        )
          throw error;
      }
    }
    await this.call<void>((cb) => this.sftp.rename(from, to, cb));
  }
  async remove(file: string, directory: boolean) {
    await this.call<void>((cb) =>
      directory ? this.sftp.rmdir(file, cb) : this.sftp.unlink(file, cb),
    );
  }
  async read(file: string, destination: Writable, signal?: AbortSignal) {
    await timedPipeline(this.sftp.createReadStream(file), destination, signal);
  }
  async write(file: string, source: Readable, signal?: AbortSignal) {
    await timedPipeline(
      source,
      this.sftp.createWriteStream(file, { flags: 'wx', mode: 0o600 }),
      signal,
    );
  }
  async setMode(file: string, mode: number) {
    await this.call<void>((cb) => this.sftp.chmod(file, mode & 0o777, cb));
  }
  close() {
    this.client.destroy();
  }
}

export class FtpEndpoint implements Endpoint {
  readonly remote = true;
  readonly identity: string;
  private client = new FtpClient(30000);
  constructor(private profile: Profile) {
    this.identity = profileIdentity(profile);
  }
  async connect(password: string | undefined) {
    if (this.profile.protocol === 'ftp' && !this.profile.allowInsecure)
      throw new Error('Unencrypted FTP was not permitted');
    try {
      await this.client.access({
        host: this.profile.host,
        port: this.profile.port,
        user: this.profile.username,
        password,
        secure: this.profile.protocol === 'ftps',
        secureOptions: {
          rejectUnauthorized: true,
          ...(isIP(this.profile.host) ? {} : { servername: this.profile.host }),
        },
      });
    } catch (error) {
      this.client.close();
      throw this.profile.protocol === 'ftps'
        ? (ftpsCertificateError(error, this.profile.host) ?? error)
        : error;
    }
  }
  async list(directory: string): Promise<Entry[]> {
    return (await this.client.list(directory))
      .filter((item) => item.name !== '.' && item.name !== '..')
      .map((item) => ({
        name: item.name,
        path: endpointPath(this, directory, item.name),
        kind: item.isSymbolicLink
          ? 'link'
          : item.isDirectory
            ? 'directory'
            : item.isFile
              ? 'file'
              : 'other',
        size: item.size,
        modified: item.modifiedAt?.getTime() ?? null,
      }));
  }
  async stat(file: string): Promise<Entry> {
    const normal = path.posix.normalize(file);
    if (normal === '/') return { name: '/', path: '/', kind: 'directory', size: 0, modified: null };
    // A missing entry is proven by a successful parent listing; FTP 550 alone
    // is ambiguous (it also means permission denied) and must not mean absent.
    const entry = (await this.list(path.posix.dirname(normal))).find(
      (item) => item.name === path.posix.basename(normal),
    );
    if (!entry) throw Object.assign(new Error('File does not exist'), { code: 'ENOENT' });
    return entry;
  }
  async canonical(directory: string) {
    await this.client.cd(directory);
    return this.client.pwd();
  }
  async mkdir(directory: string) {
    await this.client.send(`MKD ${this.safe(directory)}`);
  }
  private safe(file: string) {
    if (/[\r\n\0]/.test(file)) throw new Error('Unsafe FTP path');
    return file;
  }
  async rename(from: string, to: string, replace: boolean) {
    if (!replace && (await exists(this, to))) throw new Error('Destination already exists');
    await this.client.rename(from, to);
  }
  async remove(file: string, directory: boolean) {
    if (directory) await this.client.send(`RMD ${this.safe(file)}`);
    else await this.client.remove(file);
  }
  private async abortable(operation: () => Promise<unknown>, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const cancel = () => this.close();
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      await operation();
    } finally {
      signal?.removeEventListener('abort', cancel);
    }
  }
  async read(file: string, destination: Writable, signal?: AbortSignal) {
    await this.abortable(() => this.client.downloadTo(destination, file), signal);
  }
  async write(file: string, source: Readable, signal?: AbortSignal) {
    await this.abortable(() => this.client.uploadFrom(source, file), signal);
  }
  close() {
    this.client.close();
  }
}

// Keep the library's error type visible to tooling without broadening missing-file checks.
export { FTPError };
