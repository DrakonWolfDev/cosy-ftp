# Contributing to Cosy FTP

Cosy FTP is a focused desktop file transfer client for Windows and Linux. Please read [the v1 scope](docs/SCOPE.md) and [current progress](docs/PROGRESS.md) before proposing features.

For bugs, include the app version, operating system/package format, protocol, expected behaviour and repeatable steps with disposable files. Check existing issues first. Never include real credentials or private recovery drafts. Report vulnerabilities through [SECURITY.md](SECURITY.md).

For code changes, discuss substantial features first. Keep changes focused and explain the problem, resulting behaviour and relevant validation. Contributions are accepted under the project's AGPL-3.0-only licence; submit only work you have permission to contribute.

## Development checks

Follow the platform prerequisites and build instructions in [README.md](README.md), then run:

```sh
npm ci
npm run check
node --test tests/release.test.cjs
python -m pip install -r tests/requirements.txt
npm run test:protocol
```

Protocol tests start independent loopback servers with disposable credentials. They do not contact your saved servers. Native desktop verification instructions are in [TAURI_MIGRATION.md](docs/TAURI_MIGRATION.md). Add regression coverage for substantive reliability changes, and identify which platforms were actually checked.

The retained Electron implementation is reference material. Changes to current desktop behaviour belong in the React interface and Rust/Tauri backend. Do not treat legacy test results as native verification.
