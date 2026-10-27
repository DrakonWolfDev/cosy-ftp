import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { Api, Result } from '../shared/types';

const command =
  <T>(operation: string) =>
  async (input?: unknown): Promise<Result<T>> => {
    try {
      return { ok: true, value: await invoke<T>('dispatch', { operation, input: input ?? null }) };
    } catch (error) {
      return { ok: false, error: typeof error === 'string' ? error : 'The operation failed' };
    }
  };

// React effects can unsubscribe before the asynchronous listener has registered.
function subscribe<T>(event: string, callback: (value: T) => void): () => void {
  let disposed = false;
  let unlisten: (() => void) | undefined;
  void listen<T>(event, ({ payload }) => {
    if (!disposed) callback(payload);
  })
    .then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    })
    .catch(() => {
      /* Initialisation reports an unavailable desktop runtime. */
    });
  return () => {
    disposed = true;
    unlisten?.();
  };
}

const api: Api = {
  initialise: command('initialise'),
  list: command('list'),
  chooseFolder: command('choose-folder'),
  saveProfile: command('save-profile'),
  deleteProfile: command('delete-profile'),
  connect: command('connect'),
  disconnect: command('disconnect'),
  reconnect: command('reconnect'),
  trustedHosts: command('trusted-hosts'),
  forgetHost: command('forget-host'),
  trustedCertificates: command('trusted-certificates'),
  forgetCertificate: command('forget-certificate'),
  mkdir: command('mkdir'),
  rename: command('rename'),
  remove: command('remove'),
  enqueue: command('enqueue'),
  cancelJob: command('cancel-job'),
  retryJob: command('retry-job'),
  clearJobs: command('clear-jobs'),
  openEditor: command('open-editor'),
  saveDraft: command('save-draft'),
  uploadEdit: command('upload-edit'),
  compareEdit: command('compare-edit'),
  reviewEdit: command('review-edit'),
  exportEdit: command('export-edit'),
  rebindEdit: command('rebind-edit'),
  closeEdit: command('close-edit'),
  onJobs: (callback) => subscribe('cosy:jobs', callback),
  onLog: (callback) => subscribe('cosy:log', callback),
};
if (!window.cosy) window.cosy = api;
