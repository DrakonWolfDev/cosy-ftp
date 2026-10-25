import { contextBridge, ipcRenderer } from 'electron';
import type { Api, LogEntry, TransferJob } from '../shared/types';

const invoke = (channel: string) => (input?: unknown) => ipcRenderer.invoke(channel, input);
const subscribe = <T>(channel: string, callback: (data: T) => void) => {
  const listener = (_event: Electron.IpcRendererEvent, data: T) => callback(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};
const api: Api = {
  initialise: invoke('cosy:initialise'),
  list: invoke('cosy:list'),
  chooseFolder: invoke('cosy:choose-folder'),
  saveProfile: invoke('cosy:save-profile'),
  deleteProfile: invoke('cosy:delete-profile'),
  connect: invoke('cosy:connect'),
  disconnect: invoke('cosy:disconnect'),
  reconnect: invoke('cosy:reconnect'),
  trustedHosts: invoke('cosy:trusted-hosts'),
  forgetHost: invoke('cosy:forget-host'),
  mkdir: invoke('cosy:mkdir'),
  rename: invoke('cosy:rename'),
  remove: invoke('cosy:remove'),
  enqueue: invoke('cosy:enqueue'),
  cancelJob: invoke('cosy:cancel-job'),
  retryJob: invoke('cosy:retry-job'),
  clearJobs: invoke('cosy:clear-jobs'),
  openEditor: invoke('cosy:open-editor'),
  saveDraft: invoke('cosy:save-draft'),
  uploadEdit: invoke('cosy:upload-edit'),
  compareEdit: invoke('cosy:compare-edit'),
  reviewEdit: invoke('cosy:review-edit'),
  exportEdit: invoke('cosy:export-edit'),
  rebindEdit: invoke('cosy:rebind-edit'),
  closeEdit: invoke('cosy:close-edit'),
  onJobs: (callback) => subscribe<TransferJob[]>('cosy:jobs', callback),
  onLog: (callback) => subscribe<LogEntry>('cosy:log', callback),
};
contextBridge.exposeInMainWorld('cosy', api);
