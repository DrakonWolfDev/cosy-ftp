import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Listing, Location, Profile, SessionInfo } from '../shared/types';
import {
  FtpEndpoint,
  LocalEndpoint,
  SftpEndpoint,
  type Endpoint,
  type HostVerifier,
} from './endpoints';

interface Session {
  info: SessionInfo;
  endpoint: Endpoint;
  profile?: Profile;
  password?: string;
  pending: Promise<unknown>;
}
export class Sessions {
  private sessions = new Map<string, Session>();
  constructor(private verify: HostVerifier) {
    this.sessions.set('local', {
      info: { id: 'local', label: 'This computer', path: os.homedir(), protocol: 'local' },
      endpoint: new LocalEndpoint(),
      pending: Promise.resolve(),
    });
  }
  list() {
    return [...this.sessions.values()].map((session) => ({ ...session.info }));
  }
  private get(id: string) {
    const session = this.sessions.get(id);
    if (!session) throw new Error('This session is disconnected. Connect again to continue.');
    return session;
  }
  profile(id: string) {
    return this.get(id).profile;
  }
  async create(profile: Profile, password?: string) {
    const endpoint = await this.make(profile, password);
    try {
      const directory = await endpoint.canonical(profile.initialPath);
      await endpoint.list(directory);
      const info: SessionInfo = {
        id: randomUUID(),
        label: profile.name,
        path: directory,
        protocol: profile.protocol,
        profileId: profile.id,
      };
      this.sessions.set(info.id, {
        info,
        endpoint,
        profile: { ...profile },
        password,
        pending: Promise.resolve(),
      });
      return { ...info };
    } catch (error) {
      endpoint.close();
      throw error;
    }
  }
  private async make(profile: Profile, password?: string): Promise<Endpoint> {
    const endpoint =
      profile.protocol === 'sftp' ? new SftpEndpoint(profile) : new FtpEndpoint(profile);
    try {
      if (endpoint instanceof SftpEndpoint) await endpoint.connect(password, this.verify);
      else await endpoint.connect(password);
      return endpoint;
    } catch (error) {
      endpoint.close();
      throw error;
    }
  }
  async independent(id: string): Promise<Endpoint> {
    const session = this.get(id);
    return session.profile ? this.make(session.profile, session.password) : new LocalEndpoint();
  }
  reconnect(id: string): Promise<SessionInfo> {
    const session = this.get(id);
    if (!session.profile)
      return Promise.reject(new Error('Local folders do not need reconnecting'));
    return this.with(id, async () => {
      const replacement = await this.make(session.profile!, session.password);
      if (this.sessions.get(id) !== session) {
        replacement.close();
        throw new Error('Session disconnected while reconnecting');
      }
      const previous = session.endpoint;
      session.endpoint = replacement;
      previous.close();
      return { ...session.info };
    });
  }
  with<T>(id: string, operation: (endpoint: Endpoint) => Promise<T>): Promise<T> {
    const session = this.get(id);
    const task = session.pending.then(() => {
      if (this.sessions.get(id) !== session) throw new Error('Session disconnected');
      return operation(session.endpoint);
    });
    session.pending = task.catch(() => {});
    return task;
  }
  async browse(location: Location): Promise<Listing> {
    return this.with(location.sessionId, async (endpoint) => {
      const directory = await endpoint.canonical(location.path);
      const entries = await endpoint.list(directory);
      this.get(location.sessionId).info.path = directory;
      entries.sort(
        (a, b) =>
          Number(b.kind === 'directory') - Number(a.kind === 'directory') ||
          a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
      );
      return {
        location: { sessionId: location.sessionId, path: directory },
        entries,
        parent: endpoint.remote ? path.posix.dirname(directory) : path.dirname(directory),
        label: this.get(location.sessionId).info.label,
        remote: endpoint.remote,
      };
    });
  }
  disconnect(id: string) {
    if (id === 'local') return;
    const session = this.get(id);
    session.endpoint.close();
    session.password = undefined;
    this.sessions.delete(id);
  }
  close() {
    for (const session of this.sessions.values()) session.endpoint.close();
    this.sessions.clear();
  }
}
