# Technical foundation

## Prototype history

The 0.1–0.3 previews used Electron + TypeScript + React to prove transfer and editor behaviours using `ssh2` and `basic-ftp`. Their footprint did not establish the lightweight-product requirement. The implementation and its tests remain available as migration references.

## Confirmed product direction (26 October 2026)

Rust + Tauri is the chosen product framework. The 0.4.0 working tree uses Tauri 2 as the default desktop shell and Rust for backend services. React/TypeScript remains the interface. See [TAURI_MIGRATION.md](TAURI_MIGRATION.md) for qualification status.

Rust uses `ssh2`/libssh2 for SFTP, `suppaftp` for FTP/explicit FTPS, and `keyring` for Windows Credential Manager or Linux Secret Service. FTPS uses OpenSSL for TLS session resumption and `rustls-platform-verifier` for platform certificate validation, followed by explicit certificate-pin policy before login or file data. Its session cache is isolated to one control connection. Electron-encrypted passwords cannot be reused and require re-entry. Public profiles, pinned SSH keys and editor recovery copies are imported into Tauri's application-data directory without changing the legacy files.

## Runtime boundaries

- Webview: presentation and user intent only; no Node.js runtime. `src/desktop.ts` implements the existing typed API with Tauri commands/events and result envelopes.
- Rust command dispatch accepts application operations only from the main window. Remote pages have no capability grants. CSP disallows remote scripts and embedded frames. No general filesystem or shell plugin permissions are granted to the renderer.
- Backend: validates names, paths, protocol choices and payload sizes; manages native confirmations, profiles, sessions, transfers and editor recovery.
- Each operation obtains an independent protocol connection using its logical session credentials and pinned trust. Browsing, editing and transfers do not share FTP command channels. Reconnect validates the retained session and path.
- Sequential transfer worker: bounded 128 KiB streaming, tree preflight, staging and rename commits, cancellation checks and explicit retry. It checks source metadata and staged sizes before committing; originals are never pre-deleted.
- Editor: bounded UTF-8 text, SHA-256 conflict checks before and immediately before commit, reviewed-revision checks, atomic recovery metadata, unpersisted-draft quit warnings and separate local export.
- Settings mutations are persisted before replacing in-memory settings. Credentials live in the OS store; session passwords are zeroized on drop.

## Primary references

- [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)
- [Tauri commands](https://v2.tauri.app/develop/calling-rust/)
- [Rust ssh2](https://docs.rs/ssh2/)
- [SuppaFTP](https://docs.rs/suppaftp/)
- [Keyring](https://docs.rs/keyring/)

Dependencies are locked in package-lock.json and src-tauri/Cargo.lock. Tests must establish behaviour rather than relying only on library claims. Validation on one operating system does not qualify another.
