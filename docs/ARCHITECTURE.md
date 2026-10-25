# Technical foundation

## Initial implementation decision

Use Electron + TypeScript + React for the first working spike. Node.js is available in the development environment; Rust and Qt toolchains are not. The concept's Tauri preference was provisional. Electron allows the established `ssh2` and `basic-ftp` libraries to be exercised directly and supports Windows/Linux packaging, at the cost of a larger runtime and memory footprint. This is a practical prototype decision, not proof that the lightweight-product requirement has been met. Measure package size/memory and review this choice before v1.

## Boundaries

- Sandboxed renderer: presentation and user intent only. No Node.js, raw filesystem, arbitrary IPC or shell access.
- Preload: narrowly typed API with individual allowed commands and result envelopes.
- Main process: IPC sender checks, runtime validation, credential encryption, connection lifecycle and native confirmation dialogs.
- Services: endpoint adapters for local/SFTP/FTP(S); sequential transfer queue; text edit recovery; versioned atomic JSON storage.
- Transfer operations use separate connections so browsing cannot interfere with FTP command sequencing. Remote copies stream through bounded buffers.
- Never load remote web content or navigate to remote files. Deny new windows, navigation and web permissions.

## Primary references

- [Electron security](https://www.electronjs.org/docs/latest/tutorial/security)
- [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)
- [ssh2](https://github.com/mscdex/ssh2)
- [basic-ftp](https://github.com/patrickjuchli/basic-ftp)

Dependency versions are locked in package-lock.json. Tests must establish behaviour rather than relying only on library claims. Windows build evidence does not establish Linux support.
