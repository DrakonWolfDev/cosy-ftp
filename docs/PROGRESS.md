# Implementation progress

Updated 25 October 2026. This is a working **0.1.0 development preview**, not a completed v1. Acceptance criteria are in [MILESTONES.md](../MILESTONES.md).

## Milestone status

| Milestone              | Status                                | Evidence / remaining work                                                                                                                                                                         |
| ---------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Scope               | Recorded                              | Protocols, platform targets, editor, conflict rules and exclusions in SCOPE.md.                                                                                                                   |
| 2. Foundation          | Working prototype validated           | Windows and Ubuntu builds, real SFTP/FTP/FTPS loopback transfers, independent SFTP interoperability, and packaged desktop workflows. Electron footprint still needs product review.               |
| 3. Two-pane interface  | Implemented                           | Independent local/remote panes, paths, filter, hidden files, multi-selection, bounded row rendering, saved-connections sidebar and two themes.                                                    |
| 4. Secure connections  | Implemented; field validation pending | Native SSH trust and changed-key refusal; FTPS certificate/hostname checks; encrypted passwords on Windows; safe session-only fallback on headless Linux. Other Linux keyrings remain unverified. |
| 5. Everyday operations | Implemented within preview scope      | Upload/download, recursive copies, rename, create folder, delete files/links/empty folders, queue, cancellation and whole-operation retry. No recursive delete or automatic resume.               |
| 6. Two remote panes    | Implemented                           | Real streamed remote copies, mixed FTP/SFTP transfers, independent sessions, and same-server rename/moves.                                                                                        |
| 7. Remote editing      | Implemented                           | UTF-8 editor, explicit upload, content conflicts, ordinary permission preservation, local recovery, reconnect binding and failed-recovery-write protection.                                       |
| 8. Hardening           | In progress                           | Automated protocol, desktop, accessibility and stress checks pass. Long-duration networks, more servers, manual accessibility and full metadata semantics remain open.                            |
| 9. Release             | Preview packaging only                | Windows installer/portable and Linux AppImage/deb builds. Packaged executables tested. Signing, clean installs/upgrades and final v1 qualification remain open.                                   |

## Verification performed

- **25 service/integration tests pass on Windows and Ubuntu 24.04.** Covers nested/Unicode copies, overwrite protection, permissions, cancellation, dropped streams, staging cleanup, links, self-copy prevention, queue retry/moves, text limits, recovery/conflicts, disk-write failure, credentials and IPC validation.
- Real loopback servers exercise SFTP, FTP, explicit FTPS, invalid certificates, wrong certificate hostnames and cross-protocol streaming. A separate Python/Paramiko SFTP server validates editing and POSIX replacement.
- Desktop automation covers browsing, copying, text saves, folders, profiles, themes, uploads, two SFTP sessions, moves, native password encryption or safe fallback, pinned/changed SSH keys, and renderer isolation.
- A 2,000-entry directory is scrolled, selected and filtered with bounded row rendering. Automated axe WCAG 2 A/AA and 2.1 A/AA checks pass for the editor, themes and selected rows. Manual accessibility testing is still required.
- A 128 MiB binary plus 1,000 small files successfully uploads and relays between two SFTP servers, with the binary verified by SHA-256. Windows harness run: about 47 seconds; peak RSS about 259 MiB including both in-process servers. This is not app idle memory.
- Application and test-harness type checking, production builds and the dependency audit pass. No known npm vulnerabilities were reported at verification time.
- A generated build fingerprint checks that packaged tests run the expected build. Bundled dependency notices are included.
- GitHub Actions repeats Windows/Linux checks and builds preview artifacts. Local results do not imply a hosted CI run has already passed.

Screenshots and measurements are generated under `.test-artifacts/` and excluded from Git. Windows artifacts are in `release/`, Linux artifacts in `release/linux/` for this session. These are local outputs, not a published GitHub release.

## Footprint and product decision

The Windows unpacked runtime is approximately 364 MiB; preview downloads are around 100–125 MiB. A packaged Windows startup snapshot under automation measured roughly 156 MiB aggregate private memory and 265 MiB summed working sets; the latter can double-count shared pages. Linux headless/WSL figures differ and are not directly comparable. These are preliminary observations, not performance guarantees.

Renderer-only libraries are bundled at build time and excluded from runtime node_modules. Electron remains sizeable: the original lightweight goal is **not yet proven**. Measure settled idle/startup behaviour on target desktops and review Electron against Tauri/Qt before committing to v1.

## Next useful work

1. Validate representative personal servers and real connection interruptions; extend the compatibility matrix.
2. Test Linux keyring-backed password storage and normal sandboxed desktop launches. Headless checks use a test-only sandbox accommodation.
3. Decide the footprint budget and final framework, using the tested transfer/editor behaviour as the specification if changing frameworks.
4. Qualify ownership/ACL behaviour, concurrent-writer limits, signed clean installs/upgrades, manual accessibility and long-running transfers.
5. Reassess whether SSH keys or additional server capabilities are essential for the intended users, then complete release qualification.

See [RELIABILITY.md](RELIABILITY.md) for recovery instructions and known protocol limits.
