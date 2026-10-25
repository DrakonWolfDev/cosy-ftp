export type Protocol = 'sftp' | 'ftps' | 'ftp';
export interface Profile {
  id: string;
  name: string;
  protocol: Protocol;
  host: string;
  port: number;
  username: string;
  initialPath: string;
  hasPassword: boolean;
  allowInsecure: boolean;
}
export type ProfileInput = Omit<Profile, 'id' | 'hasPassword'> & {
  id?: string;
  password?: string;
  rememberPassword: boolean;
};
export interface Location {
  sessionId: string;
  path: string;
}
export interface Entry {
  name: string;
  path: string;
  kind: 'file' | 'directory' | 'link' | 'other';
  size: number;
  modified: number | null;
  mode?: number;
}
export interface Listing {
  location: Location;
  parent: string;
  entries: Entry[];
  label: string;
  remote: boolean;
}
export interface SessionInfo {
  id: string;
  label: string;
  path: string;
  protocol: Protocol | 'local';
  profileId?: string;
}
export interface JobRequest {
  source: Location;
  destination: Location;
  names: string[];
  overwrite: boolean;
  move: boolean;
}
export interface TransferJob {
  id: string;
  request: JobRequest;
  label: string;
  state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  mode: string;
  bytes: number;
  total: number | null;
  files: number;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}
export interface EditDocument {
  id: string;
  name: string;
  location: Location;
  content: string;
  dirty: boolean;
  status: string;
  updatedAt: number;
  profileId?: string;
}
export interface LogEntry {
  time: number;
  level: 'info' | 'error';
  message: string;
}
export interface InitialState {
  buildId: string;
  home: string;
  profiles: Profile[];
  sessions: SessionInfo[];
  jobs: TransferJob[];
  documents: EditDocument[];
  logs: LogEntry[];
  version: string;
  canStorePasswords: boolean;
}
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
export interface Api {
  initialise(): Promise<Result<InitialState>>;
  list(location: Location): Promise<Result<Listing>>;
  chooseFolder(): Promise<Result<string | null>>;
  saveProfile(profile: ProfileInput): Promise<Result<Profile>>;
  deleteProfile(id: string): Promise<Result<void>>;
  connect(input: { profileId: string; password?: string }): Promise<Result<SessionInfo>>;
  disconnect(id: string): Promise<Result<void>>;
  reconnect(id: string): Promise<Result<SessionInfo>>;
  mkdir(input: { location: Location; name: string }): Promise<Result<void>>;
  rename(input: { location: Location; name: string; newName: string }): Promise<Result<void>>;
  remove(input: { location: Location; names: string[] }): Promise<Result<boolean>>;
  enqueue(request: JobRequest): Promise<Result<TransferJob>>;
  cancelJob(id: string): Promise<Result<void>>;
  retryJob(id: string): Promise<Result<TransferJob>>;
  clearJobs(): Promise<Result<void>>;
  openEditor(location: Location): Promise<Result<EditDocument>>;
  saveDraft(input: { id: string; content: string }): Promise<Result<EditDocument>>;
  uploadEdit(id: string): Promise<Result<EditDocument>>;
  rebindEdit(input: { id: string; sessionId: string }): Promise<Result<EditDocument>>;
  closeEdit(id: string): Promise<Result<boolean>>;
  onJobs(callback: (jobs: TransferJob[]) => void): () => void;
  onLog(callback: (log: LogEntry) => void): () => void;
}
declare global {
  interface Window {
    cosy: Api;
  }
}
