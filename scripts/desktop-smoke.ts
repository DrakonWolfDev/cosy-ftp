import { _electron as electron } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { sftpServer } from '../tests/fixtures/sftp-server';

async function main() {
  const root = path.resolve('.test-artifacts/desktop');
  await fs.mkdir(root, { recursive: true });
  const fixture = await fs.mkdtemp(path.join(root, 'run-'));
  const source = path.join(fixture, 'source');
  const target = path.join(fixture, 'target');
  const remoteRoot = path.join(fixture, 'remote');
  await fs.mkdir(remoteRoot);
  const remote = await sftpServer(remoteRoot);
  let activeRemote = remote;
  await fs.mkdir(source);
  await fs.mkdir(target);
  await fs.mkdir(path.join(source, 'Documents'));
  await fs.writeFile(path.join(source, 'hello.txt'), 'Hello from Cosy FTP\n');
  await fs.writeFile(path.join(source, 'settings.json'), '{\n  "calm": true\n}\n');
  await fs.writeFile(path.join(source, 'a-small.txt'), 'a');
  await fs.writeFile(path.join(source, 'z-large.txt'), 'z'.repeat(100));
  const environment: Record<string, string> = Object.fromEntries(
    Object.entries({ ...process.env, COSY_USER_DATA: path.join(fixture, 'user-data') }).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
  delete environment.ELECTRON_RUN_AS_NODE;
  const packaged = process.argv.includes('--packaged');
  const executablePath = packaged
    ? path.resolve(
        process.platform === 'win32'
          ? 'release/win-unpacked/Cosy FTP.exe'
          : 'release/linux-unpacked/cosy-ftp',
      )
    : undefined;
  const app = await electron.launch({
    executablePath,
    args: [
      ...(packaged ? [] : ['.']),
      ...(process.env.COSY_TEST_DISABLE_SANDBOX === '1' ? ['--no-sandbox'] : []),
    ],
    env: environment,
    timeout: 30000,
  });
  const errors: string[] = [];
  try {
    await app.evaluate(({ dialog }) => {
      // Native dialogs are intercepted only by the trusted test harness. No
      // bypass flag exists in the shipped application.
      (globalThis as unknown as { cosyTestDialogs: string[] }).cosyTestDialogs = [];
      dialog.showMessageBox = (async (...args: unknown[]) => {
        const options = args.at(-1) as { message?: string; detail?: string };
        (globalThis as unknown as { cosyTestDialogs: string[] }).cosyTestDialogs.push(
          `${options.message} ${options.detail}`,
        );
        return { response: 1, checkboxChecked: false };
      }) as typeof dialog.showMessageBox;
    });
    const page = await app.firstWindow();
    const expectedBuild = JSON.parse(
      await fs.readFile('dist-electron/build-info.json', 'utf8'),
    ).buildId;
    const actualBuild = await page.evaluate(async () => {
      const state = await window.cosy.initialise();
      if (!state.ok) throw new Error(state.error);
      return state.value.buildId;
    });
    assert.equal(
      actualBuild,
      expectedBuild,
      'The running executable must contain the current build',
    );
    async function accessibility(label: string) {
      // Electron supports a single controlled WebContents, not creation of the
      // helper browser tab used by axe's cross-origin-frame aggregation mode.
      const result = await new AxeBuilder({ page })
        .setLegacyMode()
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      assert.deepEqual(
        result.violations.map((item) => ({
          id: item.id,
          impact: item.impact,
          nodes: item.nodes.map((node) => ({ target: node.target, summary: node.failureSummary })),
        })),
        [],
        `${label} accessibility`,
      );
    }
    page.on('pageerror', (error) => errors.push(error.message));
    await page.getByRole('heading', { name: 'Your files. A little more settled.' }).waitFor();
    const idleMetrics = await app.evaluate(({ app }) =>
      app.getAppMetrics().map(({ type, memory }) => ({ type, memory })),
    );
    await fs.writeFile(
      path.join(root, 'metrics.json'),
      JSON.stringify({ platform: process.platform, packaged, processes: idleMetrics }, null, 2),
    );
    async function navigate(side: 'left' | 'right', directory: string) {
      const input = page.getByRole('textbox', { name: `${side} path`, exact: true });
      await input.fill(directory);
      await input.press('Enter');
      await page
        .getByRole('region', { name: `${side} file pane`, exact: true })
        .getByText('Opening folder…')
        .waitFor({ state: 'hidden' });
    }
    await navigate('left', source);
    await navigate('right', target);
    const left = page.getByRole('region', { name: 'left file pane', exact: true });
    await left.getByRole('button', { name: 'Sort left files by size', exact: true }).click();
    assert.deepEqual(await left.locator('.file-name').allTextContents(), [
      'Documents',
      'z-large.txt',
      'hello.txt',
      'settings.json',
      'a-small.txt',
    ]);
    await left.getByRole('button', { name: 'z-large.txt', exact: true }).click();
    await left
      .getByRole('button', { name: 'settings.json', exact: true })
      .click({ modifiers: ['Shift'] });
    await left.getByText(/3 selected/).waitFor();
    await left
      .getByRole('button', { name: 'a-small.txt', exact: true })
      .click({ modifiers: ['Control'] });
    await left.getByText(/4 selected/).waitFor();
    await left.getByRole('button', { name: 'Sort left files by name', exact: true }).click();
    await left.getByRole('button', { name: 'hello.txt', exact: true }).click();
    await page.getByRole('checkbox', { name: 'Select hello.txt', exact: true }).check();
    await page.getByRole('button', { name: 'Copy', exact: true }).click();
    await page.getByText('Complete', { exact: true }).waitFor();
    assert.equal(
      await fs.readFile(path.join(target, 'hello.txt'), 'utf8'),
      'Hello from Cosy FTP\n',
    );
    await left.getByRole('button', { name: 'settings.json', exact: true }).dblclick();
    const editor = page.getByRole('textbox', { name: 'Edit settings.json', exact: true });
    await editor.fill('{\n  "calm": true,\n  "tested": true\n}\n');
    await page.getByText('Working copy saved locally', { exact: true }).waitFor();
    await accessibility('Editor');
    await page.getByRole('button', { name: 'Save to disk', exact: true }).click();
    await page.getByText('Saved to disk', { exact: true }).waitFor();
    assert.match(await fs.readFile(path.join(source, 'settings.json'), 'utf8'), /tested/);
    await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await left.getByRole('button', { name: 'New folder', exact: true }).click();
    await page.getByRole('textbox', { name: 'Folder name', exact: true }).fill('A quiet folder');
    await page.getByRole('button', { name: 'Create folder', exact: true }).click();
    await left.getByRole('button', { name: 'A quiet folder', exact: true }).waitFor();
    assert.equal((await fs.stat(path.join(source, 'A quiet folder'))).isDirectory(), true);
    await page.screenshot({ path: path.join(root, 'dark.png') });
    await accessibility('Dark workspace');
    await page.getByRole('button', { name: 'Appearance', exact: true }).click();
    await page.getByRole('radio', { name: /Warm light/ }).check();
    await accessibility('Appearance settings');
    await page.screenshot({ path: path.join(root, 'appearance.png') });
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await page.screenshot({ path: path.join(root, 'light.png') });
    await accessibility('Light workspace');
    await page.getByRole('button', { name: 'New connection', exact: true }).click();
    await page
      .getByRole('textbox', { name: 'Connection name', exact: true })
      .fill('Local test server');
    await page.getByRole('textbox', { name: 'Host', exact: true }).fill('localhost');
    await page.getByRole('spinbutton', { name: 'Port', exact: true }).fill(String(remote.port));
    await page.getByRole('textbox', { name: 'Username', exact: true }).fill('tester');
    await page.getByRole('textbox', { name: 'Password', exact: true }).fill('test-password');
    const remember = page.getByRole('checkbox', {
      name: 'Remember password using secure system storage',
      exact: true,
    });
    const nativeSecretAvailable = await remember.isEnabled();
    if (nativeSecretAvailable) await remember.check();
    await page.getByRole('button', { name: 'Save connection', exact: true }).click();
    await page.getByRole('button', { name: /Local test server SFTP/ }).waitFor();
    const persisted = await fs.readFile(
      path.join(fixture, 'user-data', 'connections.json'),
      'utf8',
    );
    assert.equal(
      persisted.includes('test-password'),
      false,
      'Settings must never contain a plaintext password',
    );
    assert.equal(Boolean(JSON.parse(persisted).profiles[0].secret), nativeSecretAvailable);
    await page.screenshot({ path: path.join(root, 'connection.png') });
    const right = page.getByRole('region', { name: 'right file pane', exact: true });
    await right.click(); // New connections open in the active pane.
    await page.getByRole('button', { name: /Local test server SFTP/ }).click();
    await page.getByRole('textbox', { name: 'Password', exact: true }).fill('test-password');
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await right.getByText('Encrypted', { exact: true }).waitFor();
    await left.getByRole('checkbox', { name: 'Select hello.txt', exact: true }).check();
    await page.getByRole('button', { name: 'Copy', exact: true }).click();
    await right.getByRole('button', { name: 'hello.txt', exact: true }).waitFor();
    assert.equal(
      await fs.readFile(path.join(remoteRoot, 'hello.txt'), 'utf8'),
      'Hello from Cosy FTP\n',
    );
    await right.getByRole('button', { name: 'New folder', exact: true }).click();
    await page.getByRole('textbox', { name: 'Folder name', exact: true }).fill('archive');
    await page.getByRole('button', { name: 'Create folder', exact: true }).click();
    await right.getByRole('button', { name: 'archive', exact: true }).waitFor();
    // Open the same saved server independently in the left pane.
    const state = await page.evaluate(async () => {
      const result = await window.cosy.initialise();
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });
    await left
      .getByLabel('left connection', { exact: true })
      .selectOption(`connect:${state.profiles[0].id}`);
    await page.getByRole('textbox', { name: 'Password', exact: true }).fill('test-password');
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await left.getByText('Encrypted', { exact: true }).waitFor();
    await navigate('right', '/archive');
    await left.getByRole('checkbox', { name: 'Select hello.txt', exact: true }).check();
    await page.getByRole('button', { name: 'Move', exact: true }).click();
    await right.getByRole('button', { name: 'hello.txt', exact: true }).waitFor();
    assert.equal(
      await fs.readFile(path.join(remoteRoot, 'archive', 'hello.txt'), 'utf8'),
      'Hello from Cosy FTP\n',
    );
    await assert.rejects(fs.stat(path.join(remoteRoot, 'hello.txt')), { code: 'ENOENT' });
    const beforeReconnect = await page.evaluate(async () => {
      const result = await window.cosy.initialise();
      if (!result.ok) throw new Error(result.error);
      return result.value.sessions.map((item) => item.id).sort();
    });
    remote.drop();
    await right.getByRole('button', { name: 'right refresh', exact: true }).click();
    await right.getByText('Couldn’t open this location', { exact: true }).waitFor();
    await right.getByRole('button', { name: 'Reconnect session', exact: true }).click();
    await right.getByRole('button', { name: 'hello.txt', exact: true }).waitFor();
    assert.equal(
      await right.getByRole('textbox', { name: 'right path', exact: true }).inputValue(),
      '/archive',
    );
    await left.getByRole('button', { name: 'Reconnect session', exact: true }).click();
    await left.getByRole('button', { name: 'archive', exact: true }).waitFor();
    const afterReconnect = await page.evaluate(async () => {
      const result = await window.cosy.initialise();
      if (!result.ok) throw new Error(result.error);
      return result.value.sessions;
    });
    assert.deepEqual(afterReconnect.map((item) => item.id).sort(), beforeReconnect);
    const dialogs = await app.evaluate(
      () => (globalThis as unknown as { cosyTestDialogs: string[] }).cosyTestDialogs,
    );
    assert.equal(
      dialogs.filter((message) => message.includes('Trust the SSH host key')).length,
      1,
      'The trusted SSH key should be pinned and reused',
    );
    assert.match(dialogs[0], /SHA256:/);
    await page.screenshot({ path: path.join(root, 'remote.png') });
    // The same hostname/port with a new key must fail without offering first-use
    // trust again. This exercises the real main-process trust store and IPC.
    await remote.close();
    const changedKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({ type: 'pkcs1', format: 'pem' })
      .toString();
    activeRemote = await sftpServer(remoteRoot, { key: changedKey, port: remote.port });
    const changed = await page.evaluate(
      async (id) => window.cosy.connect({ profileId: id, password: 'test-password' }),
      state.profiles[0].id,
    );
    assert.equal(changed.ok, false);
    const dialogsAfterChange = await app.evaluate(
      () => (globalThis as unknown as { cosyTestDialogs: string[] }).cosyTestDialogs,
    );
    assert.equal(
      dialogsAfterChange.length,
      dialogs.length,
      'A changed host key must not be accepted through another first-use prompt',
    );
    const contextIsolation = await app.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents as unknown as {
        getLastWebPreferences(): Electron.WebPreferences;
      };
      const preferences = contents.getLastWebPreferences();
      return {
        contextIsolation: preferences.contextIsolation,
        sandbox: preferences.sandbox,
        nodeIntegration: preferences.nodeIntegration,
      };
    });
    assert.deepEqual(contextIsolation, {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    });
    assert.equal(
      await page.evaluate(() => typeof (window as unknown as { require?: unknown }).require),
      'undefined',
    );
    const large = path.join(fixture, 'large-directory');
    await fs.mkdir(large);
    for (let batch = 0; batch < 20; batch++)
      await Promise.all(
        Array.from({ length: 100 }, (_, index) =>
          fs.writeFile(
            path.join(large, `entry-${String(batch * 100 + index).padStart(5, '0')}.txt`),
            '',
          ),
        ),
      );
    await left.getByLabel('left connection', { exact: true }).selectOption('local');
    await left.getByText('Local', { exact: true }).waitFor();
    await navigate('left', large);
    await left.getByText('2000 items', { exact: true }).waitFor();
    assert.ok(
      (await left.locator('.file-name').count()) < 100,
      'Large folders should render a bounded window of rows',
    );
    const fileList = left.getByRole('group', { name: 'left files', exact: true });
    await fileList.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await left.getByRole('button', { name: 'entry-01999.txt', exact: true }).waitFor();
    await fileList.focus();
    await page.keyboard.press('Control+a');
    await left.getByText(/2000 selected/).waitFor();
    await accessibility('Large directory with selected rows');
    await page.getByRole('button', { name: 'Muted dark theme', exact: true }).click();
    await accessibility('Dark selected rows');
    await page.screenshot({ path: path.join(root, 'large-directory.png') });
    await left.getByRole('textbox', { name: 'left filter files', exact: true }).fill('entry-00001');
    await left.getByRole('button', { name: 'entry-00001.txt', exact: true }).waitFor();
    assert.equal(await left.locator('.file-name').count(), 1);
    await page.getByRole('button', { name: 'Warm light theme', exact: true }).click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    assert.deepEqual(errors, []);
    console.log(
      `Desktop smoke passed: local browsing/copy/edit, sorting/range selection, Appearance settings, folders, profiles, remote upload, two SFTP sessions, reconnect after network loss, same-server move, pinned/changed SSH keys, renderer isolation, and native password-storage ${nativeSecretAvailable ? 'encryption' : 'fallback'}.`,
    );
  } finally {
    await app.close();
    await activeRemote.close();
  }
  const reopened = await electron.launch({
    executablePath,
    args: [
      ...(packaged ? [] : ['.']),
      ...(process.env.COSY_TEST_DISABLE_SANDBOX === '1' ? ['--no-sandbox'] : []),
    ],
    env: environment,
    timeout: 30000,
  });
  try {
    const page = await reopened.firstWindow();
    await page.getByRole('heading', { name: 'Your files. A little more settled.' }).waitFor();
    assert.equal(
      await page.evaluate(() => document.documentElement.dataset.theme),
      'light',
      'Warm light preference must survive a complete app restart',
    );
    console.log('Theme preference survives app restart.');
  } finally {
    await reopened.close();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
