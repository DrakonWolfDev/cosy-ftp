import { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage, session } from 'electron';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import type { LogEntry, Result } from '../shared/types';
import { SettingsStore, type Secrets } from './store';
import { Sessions } from './sessions';
import { TransferQueue } from './transfers';
import { EditorService } from './editor';
import { endpointPath, exists } from './endpoints';
import { draft, errorMessage, id, job, location, name, profile } from './validation';

let window: BrowserWindow;
let queue: TransferQueue;
let sessions: Sessions;
let editor: EditorService;
let quitting = false;
const logs: LogEntry[] = [];
const indexFile = path.resolve(__dirname, '../../dist/index.html');
const indexUrl = pathToFileURL(indexFile).href;

function log(message: string, level: LogEntry['level'] = 'info') {
  const entry = { time: Date.now(), level, message };
  logs.push(entry);
  if (logs.length > 200) logs.shift();
  if (window && !window.isDestroyed()) window.webContents.send('cosy:log', entry);
}
function handle<T extends z.ZodType, R>(
  channel: string,
  schema: T,
  operation: (input: z.infer<T>) => Promise<R> | R,
) {
  ipcMain.handle(channel, async (event, raw): Promise<Result<R>> => {
    if (
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      event.senderFrame?.url !== indexUrl
    )
      return { ok: false, error: 'Untrusted application frame' };
    try {
      return { ok: true, value: await operation(schema.parse(raw)) };
    } catch (error) {
      // Do not log raw protocol errors: some servers echo authentication data.
      log(
        `${channel.replace('cosy:', '')} failed. See the operation message for details.`,
        'error',
      );
      return { ok: false, error: errorMessage(error) };
    }
  });
}

async function start() {
  const { buildId } = JSON.parse(
    await fs.readFile(path.resolve(__dirname, '../build-info.json'), 'utf8'),
  ) as { buildId: string };
  const dataDirectory = app.getPath('userData');
  const secrets: Secrets = {
    async available() {
      const available = await safeStorage.isAsyncEncryptionAvailable();
      if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')
        return false;
      return available;
    },
    async encrypt(value) {
      return (await safeStorage.encryptStringAsync(value)).toString('base64');
    },
    async decrypt(value) {
      return (await safeStorage.decryptStringAsync(Buffer.from(value, 'base64'))).result;
    },
  };
  const settings = new SettingsStore(path.join(dataDirectory, 'connections.json'), secrets);
  await settings.load();
  const pendingTrust = new Map<string, Promise<boolean>>();
  sessions = new Sessions(async (host, fingerprint) => {
    const existing = settings.hostKey(host);
    if (existing === fingerprint) return true;
    if (existing) {
      log(`Refused a changed SSH host key for ${host}`, 'error');
      return false;
    }
    const key = `${host}:${fingerprint}`;
    let pending = pendingTrust.get(key);
    if (!pending) {
      pending = (async () => {
        const result = await dialog.showMessageBox(window, {
          type: 'question',
          title: 'Verify this server',
          message: `Trust the SSH host key for ${host}?`,
          detail: `Fingerprint: ${fingerprint}\n\nCompare this with a fingerprint provided by your server administrator through a trusted channel.`,
          buttons: ['Cancel', 'Trust and connect'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        });
        if (result.response !== 1) return false;
        // A concurrent first connection must not overwrite a different key.
        const now = settings.hostKey(host);
        if (now && now !== fingerprint) return false;
        await settings.trustHost(host, fingerprint);
        return true;
      })();
      pendingTrust.set(key, pending);
      void pending.finally(() => pendingTrust.delete(key)).catch(() => {});
    }
    return pending;
  });
  queue = new TransferQueue(
    (sessionId) => sessions.independent(sessionId),
    (jobs) => {
      if (window && !window.isDestroyed()) window.webContents.send('cosy:jobs', jobs);
    },
  );
  editor = new EditorService(path.join(dataDirectory, 'recovery'), sessions);
  await editor.load();
  window = new BrowserWindow({
    title: 'Cosy FTP',
    width: 1360,
    height: 900,
    minWidth: 980,
    minHeight: 680,
    icon: path.resolve(__dirname, '../../build/icon.png'),
    backgroundColor: '#171c1a',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });
  Menu.setApplicationMenu(null);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  session.defaultSession.setPermissionCheckHandler(() => false);
  window.once('ready-to-show', () => window.show());
  window.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    void (async () => {
      if (queue.active()) {
        const response = await dialog.showMessageBox(window, {
          type: 'warning',
          message: 'Quit and stop active transfers?',
          detail:
            'Completed files remain. Incomplete staging files may need cleanup. Editor recovery copies remain on this computer.',
          buttons: ['Keep working', 'Quit'],
          defaultId: 0,
          cancelId: 0,
        });
        if (response.response !== 1) return;
      }
      await editor.flush();
      quitting = true;
      queue.shutdown();
      sessions.close();
      window.close();
    })();
  });

  handle('cosy:initialise', z.undefined(), async () => ({
    buildId,
    home: os.homedir(),
    profiles: settings.list(),
    sessions: sessions.list(),
    jobs: queue.list(),
    documents: editor.list(),
    logs,
    version: app.getVersion(),
    canStorePasswords: await secrets.available(),
  }));
  handle('cosy:list', location, (input) => sessions.browse(input));
  handle(
    'cosy:choose-folder',
    z.undefined(),
    async () =>
      (await dialog.showOpenDialog(window, { properties: ['openDirectory'] })).filePaths[0] ?? null,
  );
  handle('cosy:save-profile', profile, (input) => settings.save(input));
  handle('cosy:delete-profile', id, async (input) => {
    if (sessions.list().some((session) => session.profileId === input))
      throw new Error('Disconnect this connection before removing it');
    await settings.delete(input);
  });
  handle(
    'cosy:connect',
    z.object({ profileId: id, password: z.string().max(8192).optional() }).strict(),
    async (input) => {
      const saved = settings.get(input.profileId);
      const result = await sessions.create(
        saved,
        input.password ?? (await settings.password(saved.id)),
      );
      log(`Connected to ${saved.name} (${saved.protocol.toUpperCase()})`);
      return result;
    },
  );
  handle('cosy:disconnect', id, (input) => {
    if (
      queue
        .list()
        .some(
          (job) =>
            (job.state === 'queued' || job.state === 'running') &&
            [job.request.source.sessionId, job.request.destination.sessionId].includes(input),
        )
    )
      throw new Error('Finish or cancel transfers using this session before disconnecting');
    sessions.disconnect(input);
    log('Session disconnected');
  });
  handle('cosy:mkdir', z.object({ location, name }).strict(), (input) =>
    sessions.with(input.location.sessionId, (endpoint) =>
      endpoint.mkdir(endpointPath(endpoint, input.location.path, input.name)),
    ),
  );
  handle('cosy:rename', z.object({ location, name, newName: name }).strict(), (input) =>
    sessions.with(input.location.sessionId, async (endpoint) => {
      const target = endpointPath(endpoint, input.location.path, input.newName);
      if (await exists(endpoint, target)) throw new Error('Destination already exists');
      await endpoint.rename(endpointPath(endpoint, input.location.path, input.name), target, false);
    }),
  );
  handle(
    'cosy:remove',
    z.object({ location, names: z.array(name).min(1).max(10000) }).strict(),
    async (input) => {
      const result = await dialog.showMessageBox(window, {
        type: 'warning',
        message: `Permanently delete ${input.names.length === 1 ? input.names[0] : `${input.names.length} selected items`}?`,
        detail: `Location: ${input.location.path}\n\nThis cannot be undone. Folders must be empty; symbolic links are removed without following their targets.`,
        buttons: ['Cancel', 'Delete permanently'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (result.response !== 1) return false;
      await sessions.with(input.location.sessionId, async (endpoint) => {
        for (const item of input.names) {
          const file = endpointPath(endpoint, input.location.path, item);
          const entry = await endpoint.stat(file);
          await endpoint.remove(file, entry.kind === 'directory');
        }
      });
      return true;
    },
  );
  handle('cosy:enqueue', job, async (input) => {
    if (input.overwrite) {
      const result = await dialog.showMessageBox(window, {
        type: 'warning',
        message: 'Replace existing destination files?',
        detail:
          'Existing regular files with matching names can be replaced. Folder copies merge with existing folders. Completed files remain if a later file fails.',
        buttons: ['Cancel', 'Copy and replace'],
        defaultId: 0,
        cancelId: 0,
      });
      if (result.response !== 1) throw new Error('Copy cancelled');
    }
    return queue.add(input);
  });
  handle('cosy:cancel-job', id, (input) => queue.cancel(input));
  handle('cosy:retry-job', id, (input) => queue.retry(input));
  handle('cosy:clear-jobs', z.undefined(), () => queue.clear());
  handle('cosy:open-editor', location, (input) => editor.open(input));
  handle('cosy:save-draft', draft, (input) => editor.draft(input.id, input.content));
  handle('cosy:upload-edit', id, (input) => editor.upload(input));
  handle('cosy:rebind-edit', z.object({ id, sessionId: id }).strict(), (input) =>
    editor.rebind(input.id, input.sessionId),
  );
  handle('cosy:close-edit', id, async (input) => {
    if (editor.dirty(input)) {
      const result = await dialog.showMessageBox(window, {
        type: 'warning',
        message: 'Discard this local draft?',
        detail: 'This removes its recovery copy. The original file will not be changed.',
        buttons: ['Keep draft', 'Discard'],
        defaultId: 0,
        cancelId: 0,
      });
      if (result.response !== 1) return false;
    }
    await editor.close(input);
    return true;
  });
  await window.loadFile(indexFile);
  log('Ready. Your files, a little more comfortably.');
}

// Allow automation to isolate all user data without touching real profiles.
if (process.env.COSY_USER_DATA) app.setPath('userData', path.resolve(process.env.COSY_USER_DATA));
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });
  app
    .whenReady()
    .then(start)
    .catch(async (error) => {
      await fs.mkdir(app.getPath('userData'), { recursive: true }).catch(() => {});
      dialog.showErrorBox('Cosy FTP could not start', errorMessage(error));
      app.exit(1);
    });
  app.on('window-all-closed', () => app.quit());
}
