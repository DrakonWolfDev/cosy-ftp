import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Profile, ProfileInput } from '../shared/types';
import { profile as profileSchema } from './validation';

export interface Secrets {
  available(): Promise<boolean>;
  encrypt(value: string): Promise<string>;
  decrypt(value: string): Promise<string>;
}
interface StoredProfile extends Profile {
  secret?: string;
}
interface Settings {
  version: 1;
  profiles: StoredProfile[];
  hosts: Record<string, string>;
}

export async function atomicJson(file: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(data, null, 2));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

export class SettingsStore {
  private data: Settings = { version: 1, profiles: [], hosts: {} };
  private chain: Promise<unknown> = Promise.resolve();
  constructor(
    private file: string,
    private secrets: Secrets,
  ) {}
  async load() {
    try {
      const data = JSON.parse(await fs.readFile(this.file, 'utf8')) as Settings;
      if (
        data.version !== 1 ||
        !Array.isArray(data.profiles) ||
        !data.hosts ||
        typeof data.hosts !== 'object'
      )
        throw new Error('Unsupported settings format');
      for (const item of data.profiles) {
        const { hasPassword: _hasPassword, ...fields } = this.publicProfile(item);
        profileSchema.parse({ ...fields, rememberPassword: false });
      }
      this.data = data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error('Settings could not be read. The original file has been preserved.');
    }
  }
  private publicProfile(item: StoredProfile): Profile {
    const { secret: _secret, ...profile } = item;
    return { ...profile, hasPassword: Boolean(item.secret) };
  }
  list() {
    return this.data.profiles.map((item) => this.publicProfile(item));
  }
  get(id: string) {
    const item = this.data.profiles.find((item) => item.id === id);
    if (!item) throw new Error('Saved connection no longer exists');
    return this.publicProfile(item);
  }
  async password(id: string) {
    const item = this.data.profiles.find((item) => item.id === id);
    return item?.secret ? this.secrets.decrypt(item.secret) : undefined;
  }
  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.chain.then(async () => {
      const previous = structuredClone(this.data);
      try {
        const result = await operation();
        await atomicJson(this.file, this.data);
        return result;
      } catch (error) {
        this.data = previous;
        throw error;
      }
    });
    this.chain = task.catch(() => {});
    return task;
  }
  save(input: ProfileInput) {
    return this.mutate(async () => {
      const parsed = profileSchema.parse(input);
      const previous = parsed.id
        ? this.data.profiles.find((item) => item.id === parsed.id)
        : undefined;
      if (parsed.id && !previous) throw new Error('Saved connection no longer exists');
      const { password, rememberPassword, id: requestedId, ...fields } = parsed;
      let secret: string | undefined;
      if (rememberPassword) {
        if (!(await this.secrets.available()))
          throw new Error(
            'Secure password storage is unavailable. Save without remembering the password.',
          );
        const sameServer =
          previous &&
          previous.protocol === fields.protocol &&
          previous.host.toLowerCase() === fields.host.toLowerCase() &&
          previous.port === fields.port &&
          previous.username === fields.username;
        secret =
          password !== undefined
            ? await this.secrets.encrypt(password)
            : sameServer
              ? previous.secret
              : undefined;
      }
      const item: StoredProfile = {
        ...fields,
        id: requestedId ?? randomUUID(),
        hasPassword: Boolean(secret),
        secret,
      };
      this.data.profiles = [...this.data.profiles.filter((p) => p.id !== item.id), item];
      return this.publicProfile(item);
    });
  }
  delete(id: string) {
    return this.mutate(async () => {
      this.data.profiles = this.data.profiles.filter((item) => item.id !== id);
    });
  }
  hostKey(key: string) {
    return this.data.hosts[key];
  }
  trustHost(key: string, fingerprint: string) {
    return this.mutate(async () => {
      this.data.hosts[key] = fingerprint;
    });
  }
}
