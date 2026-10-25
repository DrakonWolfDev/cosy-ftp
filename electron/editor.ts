import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import type { EditComparison, EditDocument, Location } from '../shared/types';
import type { Endpoint } from './endpoints';
import { endpointPath, LocalEndpoint, exists } from './endpoints';
import type { Sessions } from './sessions';
import { atomicJson } from './store';
import { errorMessage } from './validation';

export const EDIT_LIMIT = 2 * 1024 * 1024;
interface StoredDocument extends EditDocument {
  version: 1;
  baseline: string;
  identity: string;
}
const digest = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');

async function readText(endpoint: Endpoint, file: string) {
  const stat = await endpoint.stat(file);
  if (stat.kind !== 'file') throw new Error('Only regular text files can be edited');
  if (stat.size > EDIT_LIMIT) throw new Error('The text editor supports files up to 2 MiB');
  const chunks: Buffer[] = [];
  let size = 0;
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > EDIT_LIMIT) callback(new Error('File exceeds the 2 MiB editor limit'));
      else {
        chunks.push(Buffer.from(chunk));
        callback();
      }
    },
  });
  await endpoint.read(file, sink);
  const buffer = Buffer.concat(chunks);
  if (buffer.includes(0))
    throw new Error('This looks like a binary file. The editor supports UTF-8 text only.');
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
  } catch {
    throw new Error('This file is not valid UTF-8 text');
  }
  return { content, baseline: digest(buffer), mode: stat.mode };
}

export class EditorService {
  private documents = new Map<string, StoredDocument>();
  private pending: Promise<unknown> = Promise.resolve();
  private unpersisted = new Set<string>();
  constructor(
    private directory: string,
    private sessions: Sessions,
  ) {}
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.pending.then(operation);
    this.pending = task.catch(() => {});
    return task;
  }
  async load() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    for (const file of await fs.readdir(this.directory)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(file)) continue;
      const stored = JSON.parse(
        await fs.readFile(path.join(this.directory, file), 'utf8'),
      ) as StoredDocument;
      if (
        stored.version !== 1 ||
        `${stored.id}.json` !== file ||
        typeof stored.content !== 'string' ||
        typeof stored.baseline !== 'string' ||
        !stored.location ||
        Buffer.byteLength(stored.content) > EDIT_LIMIT
      )
        throw new Error(`Recovery file is invalid and has been preserved: ${file}`);
      stored.status = stored.dirty
        ? 'Recovered local draft — reconnect before uploading'
        : 'Recovered working copy — reconnect to check server';
      this.documents.set(stored.id, stored);
    }
  }
  private publicDocument(stored: StoredDocument): EditDocument {
    const { baseline: _baseline, identity: _identity, version: _version, ...document } = stored;
    return structuredClone(document);
  }
  list() {
    return [...this.documents.values()].map((document) => this.publicDocument(document));
  }
  document(id: string) {
    return this.publicDocument(this.get(id));
  }
  private get(id: string) {
    const document = this.documents.get(id);
    if (!document) throw new Error('This working copy is no longer open');
    return document;
  }
  private async persist(document: StoredDocument) {
    await atomicJson(path.join(this.directory, `${document.id}.json`), document);
    this.unpersisted.delete(document.id);
  }
  open(location: Location) {
    return this.serial(async () => {
      const existing = [...this.documents.values()].find(
        (document) =>
          document.location.sessionId === location.sessionId &&
          document.location.path === location.path,
      );
      if (existing) return this.publicDocument(existing);
      const endpoint = await this.sessions.independent(location.sessionId);
      try {
        const { content, baseline } = await readText(endpoint, location.path);
        const document: StoredDocument = {
          version: 1,
          id: randomUUID(),
          name: (endpoint.remote ? path.posix : path).basename(location.path),
          location: { ...location },
          content,
          baseline,
          identity: endpoint.identity,
          dirty: false,
          status: endpoint.remote ? 'Loaded from server' : 'Loaded from disk',
          updatedAt: Date.now(),
          profileId: this.sessions.profile(location.sessionId)?.id,
        };
        await this.persist(document);
        this.documents.set(document.id, document);
        return this.publicDocument(document);
      } finally {
        endpoint.close();
      }
    });
  }
  draft(id: string, content: string) {
    return this.serial(async () => {
      if (Buffer.byteLength(content) > EDIT_LIMIT || content.includes('\0'))
        throw new Error('Draft must be UTF-8 text up to 2 MiB');
      const document = this.get(id);
      const next = {
        ...document,
        content,
        dirty: digest(Buffer.from(content)) !== document.baseline,
        status: 'Working copy saved locally',
        updatedAt: Date.now(),
      };
      this.documents.set(id, next);
      // Keep the newest text in memory even when the disk is full. Native close
      // confirmation must still know this is a dirty draft after a failed write.
      try {
        await this.persist(next);
        this.unpersisted.delete(id);
      } catch {
        this.unpersisted.add(id);
        next.status = 'Recovery write failed — keep the editor open';
        throw new Error(
          'The recovery copy could not be saved. Your latest text is still in the open editor. Check disk space and save again.',
        );
      }
      return this.publicDocument(next);
    });
  }
  compare(id: string): Promise<EditComparison> {
    return this.serial(async () => {
      const document = this.get(id);
      const endpoint = await this.sessions.independent(document.location.sessionId);
      try {
        if (endpoint.identity !== document.identity)
          throw new Error('The connected server does not match this working copy');
        const current = await readText(endpoint, document.location.path);
        return {
          documentId: id,
          content: current.content,
          revision: current.baseline,
          changed: current.baseline !== document.baseline,
        };
      } finally {
        endpoint.close();
      }
    });
  }
  review(id: string, revision: string) {
    return this.serial(async () => {
      const document = this.get(id);
      const endpoint = await this.sessions.independent(document.location.sessionId);
      try {
        if (endpoint.identity !== document.identity)
          throw new Error('The connected server does not match this working copy');
        const current = await readText(endpoint, document.location.path);
        if (current.baseline !== revision)
          throw new Error(
            'The original changed again. Refresh the comparison and review the latest version. Your draft has been kept.',
          );
        const next: StoredDocument = {
          ...document,
          baseline: revision,
          dirty: digest(Buffer.from(document.content, 'utf8')) !== revision,
          status: 'Original reviewed — draft remains local',
          updatedAt: Date.now(),
        };
        await this.persist(next);
        this.documents.set(id, next);
        this.unpersisted.delete(id);
        return this.publicDocument(next);
      } finally {
        endpoint.close();
      }
    });
  }
  exportCopy(id: string, file: string, replace = false) {
    return this.serial(async () => {
      const document = this.get(id);
      if (!path.isAbsolute(file)) throw new Error('Choose an absolute local file path');
      const endpoint = new LocalEndpoint();
      const destination = path.join(await fs.realpath(path.dirname(file)), path.basename(file));
      if (!document.profileId) {
        const original = await fs
          .realpath(document.location.path)
          .catch(() => path.resolve(document.location.path));
        const [originalInfo, destinationInfo] = await Promise.all([
          fs.stat(original, { bigint: true }).catch(() => undefined),
          fs.lstat(destination, { bigint: true }).catch(() => undefined),
        ]);
        const sameFile =
          originalInfo &&
          destinationInfo &&
          originalInfo.ino !== 0n &&
          originalInfo.ino === destinationInfo.ino &&
          originalInfo.dev === destinationInfo.dev;
        const same =
          process.platform === 'win32'
            ? original.toLowerCase() === destination.toLowerCase()
            : original === destination;
        if (same || sameFile)
          throw new Error(
            'Save copy as must use a separate file. Use Save to disk to update the original with conflict checks.',
          );
      }
      const existing = await exists(endpoint, destination);
      let mode: number | undefined;
      if (existing) {
        const previous = await endpoint.stat(destination);
        if (previous.kind !== 'file')
          throw new Error('A draft copy cannot replace a symbolic link, folder or special file');
        if (!replace) throw new Error('Destination already exists');
        mode = previous.mode;
      }
      const temporary = path.join(path.dirname(destination), `.cosy-draft-${randomUUID()}.part`);
      try {
        const handle = await fs.open(temporary, 'wx', 0o600);
        try {
          await handle.writeFile(document.content, 'utf8');
          await handle.sync();
        } finally {
          await handle.close();
        }
        if (mode !== undefined) await endpoint.setMode(temporary, mode);
        await endpoint.rename(temporary, destination, replace);
        return destination;
      } finally {
        await fs.rm(temporary, { force: true }).catch(() => {});
      }
    });
  }
  upload(id: string) {
    return this.serial(async () => {
      const document = this.get(id);
      const endpoint = await this.sessions.independent(document.location.sessionId);
      let temporary: string | undefined;
      try {
        if (endpoint.identity !== document.identity)
          throw new Error('The connected server does not match this working copy');
        const current = await readText(endpoint, document.location.path);
        if (current.baseline !== document.baseline)
          throw new Error(
            'The original file changed since it was opened. Your draft is preserved locally. Compare it with a fresh copy before replacing the original.',
          );
        const api = endpoint.remote ? path.posix : path;
        temporary = endpointPath(
          endpoint,
          api.dirname(document.location.path),
          `.cosy-edit-${randomUUID()}.part`,
        );
        const buffer = Buffer.from(document.content, 'utf8');
        await endpoint.write(temporary, Readable.from(buffer));
        if ((await endpoint.stat(temporary)).size !== buffer.length)
          throw new Error('The staged save is incomplete');
        // Check immediately before commit as well as before uploading.
        const latest = await readText(endpoint, document.location.path);
        if (latest.baseline !== document.baseline)
          throw new Error('The original changed during upload. Your draft is preserved locally.');
        if (latest.mode !== undefined) await endpoint.setMode?.(temporary, latest.mode);
        await endpoint.rename(temporary, document.location.path, true);
        temporary = undefined;
        const next: StoredDocument = {
          ...document,
          baseline: digest(buffer),
          dirty: false,
          status: endpoint.remote ? 'Saved to server' : 'Saved to disk',
          updatedAt: Date.now(),
        };
        this.documents.set(id, next);
        this.unpersisted.delete(id);
        try {
          await this.persist(next);
        } catch {
          throw new Error(
            `${endpoint.remote ? 'Saved to server' : 'Saved to disk'}, but the local recovery metadata could not be updated. Keep a copy of your text and check available disk space.`,
          );
        }
        return this.publicDocument(next);
      } catch (error) {
        if (temporary) {
          try {
            await endpoint.remove(temporary, false);
          } catch {
            let cleanup: Endpoint | undefined;
            try {
              cleanup = await this.sessions.independent(document.location.sessionId);
              await cleanup.remove(temporary, false);
            } catch {
              throw new Error(
                `${errorMessage(error)}. Your local draft is preserved. A temporary file may remain at ${temporary}`,
              );
            } finally {
              cleanup?.close();
            }
          }
        }
        throw error;
      } finally {
        endpoint.close();
      }
    });
  }
  rebind(id: string, sessionId: string) {
    return this.serial(async () => {
      const document = this.get(id);
      const profile = this.sessions.profile(sessionId);
      if (document.profileId ? profile?.id !== document.profileId : sessionId !== 'local')
        throw new Error('Reconnect using the same saved connection as this draft');
      const endpoint = await this.sessions.independent(sessionId);
      try {
        if (endpoint.identity !== document.identity)
          throw new Error(
            'Connection details changed; cannot bind this draft to a different server',
          );
        const next = {
          ...document,
          location: { ...document.location, sessionId },
          status: 'Reconnected — original will be checked before saving',
        };
        await this.persist(next);
        this.documents.set(id, next);
        return this.publicDocument(next);
      } finally {
        endpoint.close();
      }
    });
  }
  close(id: string) {
    return this.serial(async () => {
      this.get(id);
      await fs.unlink(path.join(this.directory, `${id}.json`));
      this.documents.delete(id);
      this.unpersisted.delete(id);
    });
  }
  dirty(id: string) {
    return this.get(id).dirty;
  }
  async flush() {
    for (;;) {
      const pending = this.pending;
      await pending;
      if (pending === this.pending) return;
    }
  }
  hasUnpersistedChanges() {
    return this.unpersisted.size > 0;
  }
}
