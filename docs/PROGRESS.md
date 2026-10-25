# Implementation progress

Updated 25 October 2026. This is a working **0.3.0 development preview**, not a completed v1. Acceptance criteria are in [MILESTONES.md](../MILESTONES.md).

## 0.3.0 follow-up

- Side-by-side original/draft comparison and explicit conflict review. Stale reviews are refused; review does not upload, and later saves still check for changes.
- Native Save copy as exports drafts without changing their original binding or saved status. It works offline and after recovery-write failures, and protects local originals and symbolic-link destinations.
- Quit protection tracks failed recovery writes, keeps the app open when the warning is cancelled, and lets the user rescue the in-memory text. Normal persisted drafts still close without unnecessary warnings.
- Trusted SSH servers can be inspected and explicitly forgotten after disconnecting. Cancellation preserves trust, profiles and credentials are retained, and the next connection must verify the new fingerprint. FTPS validation remains separate.
- Fixed sidebar overflow and keyboard access to the compact transfer queue. Desktop checks cover a 980×680 window, comparison and trust dialogs, export during disk-write failure, and cancelled quit/forget confirmations.

## 0.2.0 follow-up

- Reconnect existing remote sessions after network loss, preserving session IDs, last directory and editor bindings. Reconnect controls are available in failed panes and under Open sessions. Failed reconnects retain the session for another attempt.
- Sort either pane by name, size or modification date, in either direction, with folders first and unknown dates last. Shift-click selects ranges in the displayed order; Ctrl-click adjusts individual selections.
- A labelled Appearance dialog makes the existing light/dark themes easier to find. The quick switch remains, and full-restart automation verifies persistence of warm light.
- Added real SFTP relay interruption/cancellation tests: originals remain intact, partial copies are not committed, and a fresh connection removes staging files. Desktop automation also drops both browsing connections and reconnects through the actual UI without creating replacement session IDs.
- FTPS certificate failures now give desktop guidance instead of Node.js command-line suggestions. Certificate verification remains enabled.

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

- All **38 service/integration tests** pass on Windows and Ubuntu, including reviewed-conflict recovery, stale-review rejection, offline rescue export, original/link protection and trust-store failure/cancellation coverage. Local distribution builds and packaged desktop checks also pass on both platforms for 0.3.0.
- Real loopback servers exercise SFTP, FTP, explicit FTPS, invalid certificates, wrong certificate hostnames and cross-protocol streaming. A separate Python/Paramiko SFTP server validates editing and POSIX replacement.
- Desktop automation covers browsing, copying, text saves, folders, profiles, themes, uploads, two SFTP sessions, moves, native password encryption or safe fallback, pinned/changed SSH keys, and renderer isolation.
- A 2,000-entry directory is scrolled, selected and filtered with bounded row rendering. Automated axe WCAG 2 A/AA and 2.1 A/AA checks pass for the editor, themes and selected rows. Manual accessibility testing is still required.
- A 128 MiB binary plus 1,000 small files successfully uploads and relays between two SFTP servers, with the binary verified by SHA-256. Windows harness run: about 47 seconds; peak RSS about 259 MiB including both in-process servers. This is not app idle memory.
- Application and test-harness type checking, production builds and the dependency audit pass. No known npm vulnerabilities were reported at verification time.
- A generated build fingerprint checks that packaged tests run the expected build. Bundled dependency notices are included.
- [Hosted 0.3.0 verification passed on Windows and Ubuntu](https://github.com/DrakonWolfDev/cosy-ftp/actions/runs/40195790106) for application commit `98e79f0`: all 38 service/integration tests, desktop/accessibility workflows, conflict review, draft rescue and quit protection, SSH trust management, compact layout, dropped-session reconnection, theme persistence across full restarts, distribution packaging, packaged-executable tests, checksums and artifact uploads. Windows completed in 10m31s; Ubuntu in 3m48s.

Screenshots and measurements are generated under `.test-artifacts/` and excluded from Git. Windows artifacts are in `release/`, Linux artifacts in `release/linux/` for this session. These are local outputs, not a published GitHub release.

## Footprint and product decision

The initial 0.1.0 Windows unpacked runtime was approximately 364 MiB; preview downloads were around 100–125 MiB. A packaged Windows startup snapshot under automation measured roughly 156 MiB aggregate private memory and 265 MiB summed working sets; the latter can double-count shared pages. Linux headless/WSL figures differ and are not directly comparable. These are preliminary observations, not performance guarantees.

Renderer-only libraries are bundled at build time and excluded from runtime node_modules. Electron remains sizeable: the original lightweight goal is **not yet proven**. Measure settled idle/startup behaviour on target desktops and review Electron against Tauri/Qt before committing to v1.

## Next useful work

1. Validate representative personal servers and real connection interruptions; extend the compatibility matrix.
2. Test Linux keyring-backed password storage and normal sandboxed desktop launches. Headless checks use a test-only sandbox accommodation.
3. Decide the footprint budget and final framework, using the tested transfer/editor behaviour as the specification if changing frameworks.
4. Qualify ownership/ACL behaviour, concurrent-writer limits, signed clean installs/upgrades, manual accessibility and long-running transfers.
5. Reassess whether SSH keys or additional server capabilities are essential for the intended users, then complete release qualification.

See [RELIABILITY.md](RELIABILITY.md) for recovery instructions and known protocol limits.
