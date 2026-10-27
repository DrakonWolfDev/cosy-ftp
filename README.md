# Cosy FTP

A calm two-pane file transfer client for Windows and Linux. **Development preview — not a finished v1.**

Browse local folders or independent SFTP, explicit FTPS and FTP sessions in either pane. Copy files and folders through a queue, move files on the same server, and edit remote UTF-8 text with explicit upload and local recovery copies. Choose a muted dark or warm light theme.

## Run from source

Requires Node.js 24.5 or newer, npm, current stable Rust and the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/). Windows needs Microsoft C++ Build Tools, WebView2 and native Strawberry Perl for the SSH dependency build; Linux needs WebKitGTK 4.1 and OpenSSL development libraries. The packaged application uses Rust + Tauri and does not bundle Node.js or Electron.

```sh
npm ci
npm run dev
```

`npm run dev` (or `npm start`) opens the Tauri desktop application with the Vite development server. `npm run build` compiles the native application without installers; `npm run dist` builds distribution packages. This is a desktop app, not a browser-hosted website.

On first launch, public connection profiles, pinned SSH fingerprints and editor recovery copies are imported from the Electron preview when available. The originals are retained. Remembered Electron passwords must be entered again; Tauri stores newly remembered passwords in the operating system credential store. `COSY_USER_DATA` selects an isolated data directory and disables automatic import for testing.

## Use the workspace

1. Choose a local folder in either pane using the path bar or folder chooser.
2. Add a saved connection, then select it in a pane. For SFTP, verify the first-use host-key fingerprint through a trusted channel. For self-signed FTPS, compare the certificate fingerprint with the server's FTPS administration settings and choose **Trust certificate**. See [FTPS certificate trust](docs/FTPS_CERTIFICATES.md). Plain FTP needs explicit opt-in.
3. Select items with the checkboxes. Use **Copy** or drag items to the other pane. Remote-to-remote copies pass through this computer.
4. **Move** uses a same-server/local rename and requires an unused destination name. Delete is permanent; folders must be empty.
5. Double-click a UTF-8 text file (up to 2 MiB). Changes are saved as local recovery copies. **Save to server** uploads explicitly; a changed original is refused. Reopen working copies from the editor strip after restarting, and reconnect their original saved connection when necessary.
6. Click **Name**, **Size** or **Modified** to sort either pane. Shift-click selects a range; Ctrl-click adds or removes individual items.
7. Use **Appearance** in the bottom-left sidebar to choose the colour theme. The quick sun/moon switch is still available, and the choice survives restarting the app.

If a remote browsing session drops, use **Reconnect session** in its pane or the reconnect icon under **Open sessions**. This keeps the session identity and pane location, so open editor working copies stay bound to it. Reconnect reuses that session's credentials; if the password has changed, open a new session with the updated password.

If an original changes while you are editing, choose **Compare original** in the editor. Review the fresh original beside your draft, merge the text you want to keep, then acknowledge the review and choose **Keep reviewed draft**. This records your decision locally; **Save to server/disk** is still a separate action and checks the original again. **Save copy as…** exports your current draft to a separate local file, including when the remote session or recovery storage is unavailable.

Use **Trusted SSH servers** in the sidebar to view saved SFTP fingerprints. After independently verifying a legitimate key change, disconnect that server's sessions, forget its old fingerprint and verify the new fingerprint when connecting again. FTPS certificate checks are separate.

Existing files are protected by default. **Replace existing** requires confirmation. Files are staged and then renamed; servers that refuse replacement are reported without deleting the original. Folder copies are not transactions: completed files remain if a later item fails. Symbolic links and special files are not recursively copied.

## Check and package

```sh
npm run check
npm run test:protocol
npm run package
npm run dist
```

`check` type-checks the interface and retained prototype test harnesses, runs Rust unit tests, builds the interface and checks the native backend. `test:protocol` runs Rust tests against independent Python loopback SFTP/FTP/FTPS servers and needs Python 3.12+ and these dependencies:

```sh
python -m pip install -r tests/requirements.txt
```

Set `COSY_PYTHON=python` on Windows if Python is not available as `python3`. Tests use temporary files and loopback-only servers with disposable credentials. The old TypeScript service tests remain available as `npm run test:legacy`; their results establish prototype behaviour, not Rust parity.

`package` and `dist` create Windows NSIS or Linux AppImage/deb packages under `src-tauri/target/release/bundle/` on the matching operating system. Preview packages are unsigned. Old files under `release/` are Electron builds and are not refreshed by Tauri commands.

## Project documents

- [Milestones and acceptance criteria](MILESTONES.md)
- [Progress and verification evidence](docs/PROGRESS.md)
- [v1 scope](docs/SCOPE.md)
- [Architecture and framework decision](docs/ARCHITECTURE.md)
- [Reliability limits and recovery](docs/RELIABILITY.md)
- [Original concept](PROJECT_IDEAS.md)

The 0.4.0 working tree migrates the application to Rust + Tauri, retaining React/TypeScript. The Electron implementation remains as a reference for parity testing. Native qualification and footprint measurements are tracked in the [migration notes](docs/TAURI_MIGRATION.md).
