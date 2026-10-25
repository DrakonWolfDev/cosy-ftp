import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PassThrough, Transform } from 'node:stream';
import type { Entry, JobRequest, TransferJob } from '../shared/types';
import { endpointPath, exists, type Endpoint } from './endpoints';
import { errorMessage } from './validation';

type Factory = (sessionId: string) => Promise<Endpoint>;

export function nestedPath(parent: string, candidate: string, remote: boolean) {
  const api = remote ? path.posix : path;
  const relative = api.relative(parent, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${api.sep}`) && relative !== '..' && !api.isAbsolute(relative))
  );
}

export async function copyFile(
  source: Endpoint,
  target: Endpoint,
  from: string,
  to: string,
  overwrite: boolean,
  signal: AbortSignal,
  progress: (bytes: number) => void,
): Promise<void> {
  signal.throwIfAborted();
  const sourceInfo = await source.stat(from);
  if (sourceInfo.kind !== 'file') throw new Error('Only regular files can be copied');
  const targetExists = await exists(target, to);
  let mode = sourceInfo.mode;
  if (targetExists) {
    if (!overwrite) throw new Error(`Destination already exists: ${to}`);
    const previous = await target.stat(to);
    if (previous.kind !== 'file')
      throw new Error('Only a regular file can be replaced; links and folders are protected');
    mode = previous.mode ?? mode;
  }
  const api = target.remote ? path.posix : path;
  const temporary = endpointPath(target, api.dirname(to), `.cosy-${randomUUID()}.part`);
  const channel = new PassThrough({ highWaterMark: 128 * 1024 });
  const counter = new Transform({
    highWaterMark: 128 * 1024,
    transform(chunk: Buffer, _encoding, callback) {
      progress(chunk.length);
      callback(null, chunk);
    },
  });
  // Attach handlers before starting either peer: an early read/write error must
  // destroy the other side rather than leaving a blocked producer indefinitely.
  channel.on('error', () => {});
  counter.on('error', () => {});
  channel.pipe(counter);
  const abort = () => {
    const error = new Error('Transfer cancelled');
    channel.destroy(error);
    counter.destroy(error);
    source.close();
    target.close();
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    const writing = target.write(temporary, counter, signal).catch((error) => {
      channel.destroy(error);
      counter.destroy(error);
      source.close();
      throw error;
    });
    const reading = source.read(from, channel, signal).catch((error) => {
      channel.destroy(error);
      counter.destroy(error);
      target.close();
      throw error;
    });
    const results = await Promise.allSettled([reading, writing]);
    const failed = results.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    signal.throwIfAborted();
    const staged = await target.stat(temporary);
    if (staged.size !== sourceInfo.size)
      throw new Error(
        'Source size changed or the staged copy is incomplete; destination was not replaced',
      );
    const after = await source.stat(from);
    if (after.size !== sourceInfo.size || after.modified !== sourceInfo.modified)
      throw new Error('Source changed while transferring; destination was not replaced');
    if (mode !== undefined) await target.setMode?.(temporary, mode);
    await target.rename(temporary, to, overwrite);
  } catch (error) {
    // A closed connection cannot remove its stage. The caller retries cleanup on
    // a fresh endpoint and reports the exact path if cleanup still fails.
    try {
      await target.remove(temporary, false);
    } catch (cleanup) {
      if (await exists(target, temporary).catch(() => true))
        throw Object.assign(
          new Error(`${errorMessage(error)}. Staging file may remain: ${temporary}`),
          { stagingPath: temporary, cause: error, cleanup },
        );
    }
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
    channel.destroy();
    counter.destroy();
  }
}

export class TransferQueue {
  private jobs: TransferJob[] = [];
  private working = false;
  private controller?: AbortController;
  private lastUpdate = 0;
  constructor(
    private factory: Factory,
    private notify: (jobs: TransferJob[]) => void,
  ) {}
  list() {
    return structuredClone(this.jobs);
  }
  add(request: JobRequest) {
    if (this.jobs.length >= 1000) throw new Error('Clear finished transfers before adding more');
    const job: TransferJob = {
      id: randomUUID(),
      request: structuredClone(request),
      label: request.names.length === 1 ? request.names[0] : `${request.names.length} items`,
      state: 'queued',
      mode: request.move ? 'Moving on server' : 'Copying',
      bytes: 0,
      total: null,
      files: 0,
    };
    this.jobs.push(job);
    this.emit();
    void this.run();
    return structuredClone(job);
  }
  cancel(id: string) {
    const job = this.jobs.find((job) => job.id === id);
    if (job?.state === 'queued') {
      job.state = 'cancelled';
      job.finishedAt = Date.now();
      this.emit();
    }
    if (job?.state === 'running') this.controller?.abort();
  }
  retry(id: string) {
    const job = this.jobs.find((job) => job.id === id);
    if (!job || (job.state !== 'failed' && job.state !== 'cancelled'))
      throw new Error('Only failed or cancelled transfers can be retried');
    return this.add(job.request);
  }
  clear() {
    this.jobs = this.jobs.filter((job) => job.state === 'queued' || job.state === 'running');
    this.emit();
  }
  active() {
    return this.jobs.some((job) => job.state === 'running' || job.state === 'queued');
  }
  shutdown() {
    for (const job of this.jobs) if (job.state === 'queued') job.state = 'cancelled';
    this.controller?.abort();
  }
  private emit() {
    this.lastUpdate = Date.now();
    this.notify(this.list());
  }
  private async run() {
    if (this.working) return;
    this.working = true;
    try {
      for (;;) {
        const job = this.jobs.find((job) => job.state === 'queued');
        if (!job) break;
        this.controller = new AbortController();
        job.state = 'running';
        job.startedAt = Date.now();
        this.emit();
        try {
          await this.execute(job, this.controller.signal);
          job.state = 'completed';
        } catch (error) {
          const staging = (error as { stagingPath?: string }).stagingPath;
          if (staging) {
            let cleanup: Endpoint | undefined;
            try {
              cleanup = await this.factory(job.request.destination.sessionId);
              await cleanup.remove(staging, false);
              error = (error as { cause?: unknown }).cause ?? error;
            } catch {
              /* Keep the explicit staging path in the error for manual cleanup. */
            } finally {
              cleanup?.close();
            }
          }
          job.state = this.controller.signal.aborted ? 'cancelled' : 'failed';
          job.error = `${errorMessage(error)}${job.files ? ` (${job.files} completed files remain at the destination.)` : ''}`;
        }
        job.finishedAt = Date.now();
        this.emit();
      }
    } finally {
      this.controller = undefined;
      this.working = false;
    }
  }
  private async execute(job: TransferJob, signal: AbortSignal) {
    let source: Endpoint | undefined;
    let target: Endpoint | undefined;
    try {
      source = await this.factory(job.request.source.sessionId);
      signal.throwIfAborted();
      target = await this.factory(job.request.destination.sessionId);
      signal.throwIfAborted();
      const sourceDir = await source.canonical(job.request.source.path);
      const targetDir = await target.canonical(job.request.destination.path);
      const same = source.identity === target.identity;
      if (job.request.move && !same)
        throw new Error(
          'Moves are supported only within the same server or local filesystem. Use Copy between servers.',
        );
      job.mode = job.request.move
        ? source.remote
          ? 'Moving on server'
          : 'Moving on this computer'
        : source.remote && target.remote
          ? 'Transferring through this computer'
          : source.remote
            ? 'Downloading'
            : target.remote
              ? 'Uploading'
              : 'Copying on this computer';
      const items: { from: string; to: string; entry: Entry }[] = [];
      for (const name of job.request.names) {
        signal.throwIfAborted();
        const from = endpointPath(source, sourceDir, name);
        const to = endpointPath(target, targetDir, name);
        const entry = await source.stat(from);
        if (
          same &&
          (from === to ||
            (!source.remote &&
              process.platform === 'win32' &&
              from.toLowerCase() === to.toLowerCase()))
        )
          throw new Error('Source and destination are the same');
        if (same && entry.kind === 'directory') {
          const canonicalSource = await source.canonical(from);
          if (nestedPath(canonicalSource, targetDir, source.remote))
            throw new Error('Cannot copy or move a folder into itself');
        }
        if ((await exists(target, to)) && (!job.request.overwrite || job.request.move))
          throw new Error(`Destination already exists: ${name}`);
        items.push({ from, to, entry });
      }
      if (job.request.move) {
        for (const item of items) {
          signal.throwIfAborted();
          await source.rename(item.from, item.to, false);
          job.files++;
          this.emit();
        }
        return;
      }
      // Preflight the entire tree before creating destination directories.
      const files: { from: string; to: string; size: number }[] = [];
      const directories: string[] = [];
      let total = 0;
      const walk = async (
        from: string,
        to: string,
        entry: Entry,
        depth: number,
        parentMissing = false,
      ) => {
        signal.throwIfAborted();
        if (depth > 100 || files.length + directories.length >= 100000)
          throw new Error('Directory tree exceeds the safety limit (100 levels / 100,000 items)');
        if (entry.kind === 'directory') {
          directories.push(to);
          const missing = parentMissing || !(await exists(target!, to));
          if (!missing && (await target!.stat(to)).kind !== 'directory')
            throw new Error(`A non-directory blocks the destination: ${to}`);
          for (const child of await source!.list(from))
            await walk(
              endpointPath(source!, from, child.name),
              endpointPath(target!, to, child.name),
              child,
              depth + 1,
              missing,
            );
        } else if (entry.kind === 'file') {
          if (!parentMissing && (await exists(target!, to))) {
            if (!job.request.overwrite || (await target!.stat(to)).kind !== 'file')
              throw new Error(`Destination already exists or is not a regular file: ${to}`);
          }
          total += entry.size;
          files.push({ from, to, size: entry.size });
        } else throw new Error(`Symbolic links and special files are not copied: ${from}`);
      };
      for (const item of items) await walk(item.from, item.to, item.entry, 0);
      job.total = total;
      this.emit();
      for (const directory of directories) {
        signal.throwIfAborted();
        if (!(await exists(target, directory))) await target.mkdir(directory);
      }
      for (const file of files) {
        signal.throwIfAborted();
        await copyFile(
          source,
          target,
          file.from,
          file.to,
          job.request.overwrite,
          signal,
          (bytes) => {
            job.bytes += bytes;
            if (Date.now() - this.lastUpdate > 100) this.emit();
          },
        );
        job.files++;
        this.emit();
      }
    } finally {
      source?.close();
      target?.close();
    }
  }
}
