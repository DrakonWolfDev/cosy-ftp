# Cosy FTP

A calm two-pane file transfer client for Windows and Linux. **Development preview — not a finished v1.**

Browse local folders or independent SFTP, explicit FTPS and FTP sessions in either pane. Copy files and folders through a queue, move files on the same server, and edit remote UTF-8 text with explicit upload and local recovery copies. Choose a muted dark or warm light theme.

## Run from source

Requires Node.js 24.5 or newer and npm. The packaged application does not require Node.js.

```sh
npm ci
npm run dev
```

`npm run dev` builds and opens the desktop application. After a build, `npm start` opens it again. This is a desktop app, not a browser-hosted website.

## Use the workspace

1. Choose a local folder in either pane using the path bar or folder chooser.
2. Add a saved connection, then select it in a pane. For SFTP, verify the first-use host-key fingerprint through a trusted channel. FTPS requires a valid certificate. Plain FTP needs explicit opt-in.
3. Select items with the checkboxes. Use **Copy** or drag items to the other pane. Remote-to-remote copies pass through this computer.
4. **Move** uses a same-server/local rename and requires an unused destination name. Delete is permanent; folders must be empty.
5. Double-click a UTF-8 text file (up to 2 MiB). Changes are saved as local recovery copies. **Save to server** uploads explicitly; a changed original is refused. Reopen working copies from the editor strip after restarting, and reconnect their original saved connection when necessary.
6. Click **Name**, **Size** or **Modified** to sort either pane. Shift-click selects a range; Ctrl-click adds or removes individual items.
7. Use **Appearance** in the bottom-left sidebar to choose the colour theme. The quick sun/moon switch is still available, and the choice survives restarting the app.

If a remote browsing session drops, use **Reconnect session** in its pane or the reconnect icon under **Open sessions**. This keeps the session identity and pane location, so open editor working copies stay bound to it. Reconnect reuses that session's credentials; if the password has changed, open a new session with the updated password.

Existing files are protected by default. **Replace existing** requires confirmation. Files are staged and then renamed; servers that refuse replacement are reported without deleting the original. Folder copies are not transactions: completed files remain if a later item fails. Symbolic links and special files are not recursively copied.

## Check and package

```sh
npm run check
npm run test:desktop
npm run test:stress
npm run package
npm run test:packaged
npm run dist -- --publish never
```

`check` type-checks the app and test harnesses, runs local/SFTP tests, then builds. FTP/FTPS and independent-SFTP integration tests need Python 3.12+ and these optional test dependencies:

```sh
python -m pip install -r tests/requirements.txt
```

Enable the complete protocol suite with `$env:COSY_PROTOCOL_TESTS='1'` in PowerShell, or `export COSY_PROTOCOL_TESTS=1` in a POSIX shell, then run `npm run check`. Tests use temporary files and loopback-only servers with disposable credentials.

`package` creates an unpacked application in `release/`; `dist` creates Windows NSIS/portable or Linux AppImage/deb artifacts on the matching operating system. Preview packages are unsigned. On headless Linux, use `xvfb-run -a npm run test:desktop`; the test-only `COSY_TEST_DISABLE_SANDBOX=1` accommodates CI hosts that prohibit Chromium sandbox setup. It is not a normal application launch setting.

## Project documents

- [Milestones and acceptance criteria](MILESTONES.md)
- [Progress and verification evidence](docs/PROGRESS.md)
- [v1 scope](docs/SCOPE.md)
- [Architecture and framework decision](docs/ARCHITECTURE.md)
- [Reliability limits and recovery](docs/RELIABILITY.md)
- [Original concept](PROJECT_IDEAS.md)

Electron is the initial implementation, with a larger runtime than the provisional Tauri option in the original concept. Package footprint and memory use remain part of the framework review before v1.
