# Rust + Tauri migration

Working-tree migration started 26 October 2026, targeting 0.4.0. This is a development preview; the 0.3.0 Electron test evidence does not qualify the Rust implementation.

## Implementation

- Tauri 2 desktop shell; existing React/TypeScript interface and typed API retained.
- Rust SFTP through libssh2, FTP/explicit FTPS through SuppaFTP. FTPS uses an OpenSSL transport with platform certificate verification and explicit server-scoped pin policy.
- Logical sessions retain identity, last path and session credentials; backend operations use independent connections.
- Sequential queue with bounded streaming, tree preflight, staged commits, source-change checks, cancellation and explicit retry.
- Editor recovery, original/draft comparison, stale-review refusal, conflict checks before save and before commit, permission preservation where supported, rescue export and quit warnings for failed recovery writes.
- Windows Credential Manager/Linux Secret Service for remembered passwords. Unavailable stores permit session-only operation.
- One-time public profile, SSH trust and recovery import from Electron. Electron passwords require re-entry; original data remains intact. `COSY_USER_DATA` disables import and isolates test data.
- Tauri capabilities grant event subscriptions to the local main window. Application commands validate origin and input; external navigation and popup windows are denied. No general filesystem or shell APIs are exposed to the interface.
- Blue/slate themes and a two-pane transfer mark replace the green/leaf identity. The layout and theme preference identifiers are retained.

## Development

Install current stable Rust and the [official platform prerequisites](https://v2.tauri.app/start/prerequisites/), then `npm ci` and `npm run dev`. Windows also needs native [Strawberry Perl](https://strawberryperl.com/) for the statically bundled OpenSSL SSH dependency; set `PERL` to its perl.exe if it is not on PATH. This is a build prerequisite only. Linux uses its system OpenSSL development libraries. Use `npm run build` for a native executable, or `npm run dist` for packages. Old outputs directly under `release/` remain Electron artifacts; new local preview artifacts are kept separately under `release/tauri/`.

`npm test` runs Rust unit tests. `npm run test:protocol` runs the explicitly ignored Python loopback integration tests (install `tests/requirements.txt` first). Set `COSY_PYTHON` when Python is not named `python3`. `npm run test:legacy` retains the prototype service suite.

For native window checks, install `tauri-driver` and the platform WebDriver, build an executable with embedded assets (`cargo build --manifest-path src-tauri/Cargo.toml --features custom-protocol` after `npm run build:ui` for a debug build), then run `python scripts/tauri-smoke.py <executable>`. Headless Linux needs `xvfb-run -a`. `COSY_TAURI_DRIVER` and `COSY_NATIVE_DRIVER` can specify driver paths. Reports and screenshots go under `.test-artifacts/tauri/`; `COSY_SMOKE_ARTIFACTS` overrides the output folder.

## 0.4.6 Refresh without losing position

File rows and virtual-list spacers stay mounted during refresh, with the table inert and its container marked busy. This avoids collapsing the scroll range. Windows and Linux `.deb` desktop checks cover a 400-file remote directory scrolled over 4,000 pixels down through refresh, mkdir, rename and editor save, then verify new-directory navigation resets to the top. AppImage passes on retry after an initial WebDriver disconnection during a save. Both-theme accessibility, TypeScript and the production interface build pass; final desktop checks match the embedded source/asset fingerprint. Packages/checksums are under `release/tauri/`.

## 0.4.5 Editor workflow and size limit

Each pane has a visible Edit action. Closing an editor tab leaves the other working copies visible and selects a neighbour when necessary; the editor window's X keeps working copies for reopening. UTF-8 text, including JSON, is supported up to 10 MiB across reads, drafts and recovery validation. Windows and both Linux packages pass native workflows opening, editing and saving a 3.4 MB JSON file plus hiding/reopening and active/background tab closure. Both-theme accessibility passes. All 25 Windows / 26 Linux backend tests pass, including exact-limit and oversized-file cases; Linux Clippy, TypeScript and the production interface build pass. Local packages/checksums are under `release/tauri/`.

## 0.4.4 Connection workflow

Sidebar connections now default to the right pane, while each pane's selector remains explicit. Stored credentials are used automatically, with a password override after retrieval/authentication failure; remembering a new credential requires a password. The queue starts expanded. Dark remains the default and the light option is retained. Production Windows checks exercise actual sidebar auto-connect, explicit left-pane selection and rejected-credential fallback with Windows Credential Manager. Windows and both Linux packages pass desktop/accessibility checks with matching source/asset fingerprints. Linux checks use session-only credentials because the WSL environment has no Secret Service; Mint operation is user-reported, and Linux keyring persistence remains to be qualified.

## 0.4.3 Workspace layout

The welcome block and separate toolbar are consolidated into one compact header, pane headings use less height, and the queue starts folded but opens for active/failed transfers. File row heights and text size are retained. Windows checks include a populated FTPS pane at normal and 980 × 680 window sizes, matching source/asset fingerprints and both-theme accessibility. Like-for-like file-list measurements gain 156 CSS pixels at an 844-pixel content height and 59 pixels at 680 pixels. The Linux `.deb` and AppImage desktop checks also pass with no axe violations. Artifacts/checksums are under `release/tauri/`; visual evidence is in `.test-artifacts/tauri/layout-043/`.

## 0.4.2 FTPS session resumption

FileZilla servers enforcing data-channel TLS session resumption are supported by a per-control-connection OpenSSL session cache. TLS 1.2 and TLS 1.3 regression fixtures reject the former backend and require successful resumption for repeated directory listings, uploads and downloads. All 24 Windows / 25 Linux backend tests pass, as does Linux Clippy with warnings denied. Certificate validation uses `rustls-platform-verifier`; trust/name exceptions still require the exact certificate approval before credentials or file data. Only the control connection's tickets populate the cache, which is never shared across endpoint instances.

The final 0.4.2 Windows executable and Linux `.deb`/AppImage pass production desktop workflows against a TLS 1.3 fixture requiring resumption, with matching embedded build fingerprints and no axe violations in either theme. Windows credential-store checks pass. Packages/checksums are in `release/tauri/`; the new standalone Windows executable is `Cosy FTP_0.4.2.exe` because an older running generic executable was retained. No real-server login is claimed.

## 0.4.1 FTPS follow-up

The native backend now supports explicit certificate fingerprint approval scoped to the exact FTPS host and port. See [FTPS_CERTIFICATES.md](FTPS_CERTIFICATES.md). Verification on 27 October 2026 passes 23 tests on Linux and 22 on Windows, including six real-server protocol tests on each platform. New coverage checks approval before login, encrypted data transfers, certificate replacement, persistence failures and trust scoping. Linux Clippy passes with warnings denied.

Version 0.4.1 production Windows, `.deb` and AppImage desktop checks pass with matching embedded source/asset fingerprints and no axe violations in either theme. They cover pinned self-signed FTPS by IP, encrypted uploads and trust-removal refusal while connected. The Windows Python fixture refuses replacement renames; the test verifies the original survives and separately uploads a new filename. The native prompt was opened against a local fixture, but visual inspection could not complete because the Windows Computer Use helper's native pipe was unavailable. No visual-layout verification of that prompt is claimed. Updated packages and checksums are under `release/tauri/`.

## Qualification

Local verification on 26 October 2026:

- TypeScript type checking, the production interface build and Rust Clippy on Ubuntu/WSL (`--all-targets -- -D warnings`) pass.
- Ubuntu/WSL: 10 Rust unit tests and all 5 independent loopback protocol tests pass. Coverage includes protected originals, cancellation, recovery, imported profiles/trust, SFTP verification/authentication, remote relay, mixed FTP/SFTP relay, binary FTP transfers and FTPS certificate/hostname validation.
- The Linux debug executable, production `.deb` executable and AppImage pass native WebDriver workflows, including queued copies, local and remote editor saves, conflict/stale-review refusal, session-only profiles, connected-trust removal refusal and reconnect identity retention. Automated axe WCAG 2/2.1 A/AA checks pass in both themes. Reports/screenshots are under `.test-artifacts/tauri/`.
- An embedded SHA-256 source/asset fingerprint is checked by native desktop tests, including packaged executables, so stale builds cannot satisfy the checks merely by sharing the version number.
- Linux packages build successfully: approximately 5.38 MiB for the `.deb` and 80.28 MiB for AppImage. These formats bundle different system dependencies; they do not establish Windows footprint or settled memory use.
- Windows: 9 Rust unit tests and all 5 loopback protocol tests pass. The production executable passes the native desktop workflows and accessibility checks in both themes, including Windows Credential Manager save/retrieve/delete and no plaintext password in settings. The NSIS installer builds successfully at approximately 3.60 MiB. Reports/screenshots are under `.test-artifacts/tauri/windows/`.
- Local installers and the standalone Windows executable are under `release/tauri/`, with SHA-256 checksums in `release/tauri/SHA256SUMS.txt`. These are local preview builds, not a published release. CI now builds Tauri packages and runs native backend tests on Windows/Linux plus production desktop checks on Linux; no hosted run is claimed here.

Still required before v1: Linux keyring-backed credential testing, broader server compatibility, manual accessibility, prolonged network interruptions, signing/clean-install/upgrade checks, and settled idle/startup footprint measurements on target desktops. Cancellation is checked between streamed chunks; a blocked network operation can take up to its configured timeout to return. Servers that cannot atomically replace a file report an error while retaining the original.
