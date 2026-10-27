# Implementation progress

Updated 27 October 2026. The working tree is a **0.4.7 Rust + Tauri development preview**, not a completed v1. The 0.3.0 verification below describes the Electron prototype. Acceptance criteria are in [MILESTONES.md](../MILESTONES.md).

## 0.4.7 Release preparation, About and Wolf Update

- Andrew confirms the qualification work through release preparation complete for 0.4.6, including real use on Windows, Linux Mint and Fedora. This supersedes the outstanding field-qualification checklist below; historical automated evidence is retained as recorded.
- Added an About panel with the existing Cosy FTP transfer logo, version, credits and the small A WOLF FORGE PROJECT paw-print signature. Added a native implementation of the notification-only Wolf Update policy used by Wolf Launcher and AMP: automatic daily and manual checks, preview-release discovery, persistent version dismissal and the fixed official project-page destination.
- Prepared the Wolf Forge project write-up under On the Workbench with Coming soon downloads. It is not added to Out in the Wild.
- Added a gated tagged-release workflow reusing native verification, with Windows NSIS and Linux DEB/RPM/AppImage artifacts, checksums and the website release event. No public release is created by this preparation. See [RELEASE.md](RELEASE.md) for setup and verification.

### Local branding review

- Corrected About to lead with the existing Cosy FTP transfer logo. The small `A WOLF FORGE PROJECT` paw-print footer matches the signatures in Wolf Launcher and AMP.
- Replaced the website draft's illustrated file panels and text placeholders with real native FTPS workspace, editor and light-theme captures using disposable local demo servers. Corrected the project card to use Cosy FTP's logo.
- The corrected Windows native desktop workflows and About accessibility pass in both themes. The live manual update check displays the expected not-yet-public message for the private repository. Website desktop/mobile layout, image loading, accessibility, workbench-only placement and all four disabled download controls pass.
- The reviewed app and website changes were subsequently committed and pushed to main with the user's approval. Installers built before this branding correction do not represent the latest source.
- The separate Windows SFTP populated-subdirectory issue was subsequently reproduced and fixed during public-source preparation. The SSH library joined listed paths with native Windows separators; entries are now validated and rebuilt with remote POSIX separators. A real-server nested-directory list/read regression fails before the fix and passes after it on Windows and Linux.

### Public source preparation

- Applied the user-selected AGPL-3.0-only licence, added contributor/security guidance and a bug-report form, refreshed the README with the real product logo/screenshot, and prepared package licence resources.
- Refreshed JavaScript notices for the actual Tauri frontend and preserved an explicit legacy mode. Native binary licence/source delivery remains an explicit release-preparation task; public source and public installers are separate decisions.
- Targeted Git history scan found no configured secret-pattern matches or tracked credential files. Online npm audit reports zero vulnerabilities. All 28 Windows / 29 Linux backend/protocol tests, TypeScript, production UI and release-contract checks pass.
- Repository remains private, downloads remain Coming soon, and no release tag is created. Private vulnerability reporting must be enabled after visibility changes. See [PUBLIC_READINESS.md](PUBLIC_READINESS.md).

## 0.4.6 Preserve the file-list position

- Refreshes retain the existing rows and virtual-list spacers while loading, preventing the table from collapsing and resetting the scrollbar. The refreshing table is inert and marked busy until loading finishes. Existing folder/filter/sort navigation resets are retained.
- Native regression checks use a 400-file SFTP directory scrolled more than 4,000 pixels down, then refresh, create a folder, rename a file and save an edited file. Position stays in the same area, allowing a one-row browser scroll-anchor adjustment when entries move. Entering a different folder starts at the top.
- Windows and Linux `.deb` desktop checks pass, including editor workflows and both-theme accessibility. TypeScript and the production interface build pass.
- AppImage passes the same workflows and both-theme accessibility on retry after an initial WebDriver connection dropped during a save. Final package checks share the current embedded source/asset fingerprint. Updated 0.4.6 installers and checksums are in `release/tauri/`.

## 0.4.5 Discoverable editor and larger text files

- Added a visible Edit action in each pane for one selected regular file. Double-click still opens text files and folders; transfers remain explicit.
- Closing a background editor tab keeps the current tab visible. Closing the active tab selects its neighbour; only closing the last working copy hides the editor. Tab closing waits for pending recovery writes. The window's X is labelled as hiding the editor while keeping working copies.
- Raised the UTF-8 text limit from 2 to 10 MiB across reads, drafts, recovery validation and the interface. JSON already uses the plain text editor; the user's 2.4 MB file exceeded the previous size limit. Size, NUL-byte and invalid-UTF-8 failures now have distinct read errors.
- Backend tests verify a larger JSON file, the exact 10 MiB boundary and refusal above it. All 25 Windows / 26 Linux backend tests and Linux Clippy pass. Windows desktop checks open/edit/save a 3.4 MB JSON file through the visible Edit action, verify hiding/reopening working copies and exercise both active/background tab closure. Compact-window Edit controls and both-theme accessibility pass.
- Both Linux `.deb` and AppImage pass the same editor workflows with matching source/asset fingerprints and no accessibility violations in either theme. Updated 0.4.5 packages and checksums are under `release/tauri/`.

## 0.4.4 Connection defaults and remembered passwords

- Saved credentials are used automatically instead of showing a blank password prompt on every connection. Unavailable/rejected credentials fall back to an explicit password override. Concurrent connect attempts are guarded. Profile forms require a password when remembering one without an existing reusable credential.
- Sidebar connections default to the right pane. Explicit connection selection inside either pane still targets that pane.
- Restored the transfer queue's expanded default while keeping its manual toggle and automatic expansion for active/failed jobs. Dark remains the default; light and saved appearance choices are retained.
- The user reports successful Linux Mint use. The saved-password UI path, rejection/retry and pane-targeting checks pass with Windows Credential Manager. Linux package checks use session-only credentials because the WSL test environment has no Secret Service; Linux keyring persistence remains unverified here.
- Final 0.4.4 Windows, Linux `.deb` and AppImage desktop workflows pass with matching source/asset fingerprints and no accessibility violations in either theme. Production UI build and TypeScript checks pass. Local installers, the versioned Windows executable and checksums are under `release/tauri/`.

## 0.4.3 More room for files

- Replaced the large welcome heading and separate workspace toolbar with one compact header. Connection and transfer controls stay available; pane headings and surrounding spacing are slimmer. File text and row heights are unchanged.
- The transfer queue starts folded and opens automatically when active or failed transfers need attention. Its toggle still allows manual expansion/collapse, and completed transfers stay available for review.
- Like-for-like Windows measurements with the queue folded show the file-list viewport increasing from 340 to 496 CSS pixels at an 844-pixel content height (about four more rows per pane). At 980 × 680, it increases from 320 to 379 pixels with no horizontal document overflow. Reports and remote-pane screenshots are under `.test-artifacts/tauri/layout-043/`.
- Type checking and production UI build pass. Windows desktop workflows, a populated FTPS pane, both themes and compact-window layout were checked; both Linux packages pass native desktop workflows. Both-theme automated accessibility checks pass. Updated 0.4.3 installers, versioned Windows executable and checksums are in `release/tauri/`.

## 0.4.2 FTPS session resumption

- Fixed FileZilla's `425 ... TLS session of data connection not resumed` error. FTPS uses an OpenSSL transport with a control-connection-specific session cache for protected data sockets. Independent ticket instances support repeated TLS 1.3 transfers; data sockets do not replace the control connection's cached tickets.
- Platform certificate validation and explicit host/port certificate pins still gate login and data access. Unrelated untrusted data certificates are refused. Session tickets remain in memory, with stored serialized tickets cleared on drop.
- Strict loopback servers require resumption under TLS 1.2 and TLS 1.3. Each test confirms the former backend fails and verifies repeated listings and binary uploads/downloads with the new backend. All 24 Windows / 25 Linux backend tests and Linux Clippy pass.
- The 0.4.2 Windows production desktop check passes with the FTPS fixture requiring TLS 1.3 resumption, including both-theme accessibility and Windows credential-store checks. The new standalone Windows executable is versioned as `Cosy FTP_0.4.2.exe`; an older running `Cosy FTP.exe` was retained. Use the 0.4.2 installer or versioned executable for this fix.
- Both Linux `.deb` and AppImage desktop checks also pass with required TLS 1.3 resumption and no accessibility violations in either theme. Packages and SHA-256 checksums are under `release/tauri/`. These are local fixture results; no login to the user's real server was performed.

## 0.4.1 FTPS certificate trust

- Self-signed/private certificates and name mismatches now offer an explicit native fingerprint review before login. Approval saves the exact certificate for that host and port inside Cosy FTP, allowing verified private servers to be used by IP.
- Replacement certificates require review; expired, not-yet-valid and unsuitable certificates remain refused. Exception-mode data connections must present the approved control certificate.
- **Trusted FTPS certificates** lists saved fingerprints and supports forgetting trust after disconnecting. No operating-system trust-store or hosts-file changes are needed.
- Tests cover cancellation before login, persisted and changed trust, failed settings writes, host/port scoping and real encrypted file transfers. See [FTPS_CERTIFICATES.md](FTPS_CERTIFICATES.md) for the connection flow.
- Verification: 23 Linux / 22 Windows backend tests pass; production Windows, Linux `.deb` and AppImage desktop workflows and both-theme accessibility checks pass. Windows also verifies safe refusal when the Python fixture cannot replace an existing file, plus successful FTPS uploads to new filenames. Local 0.4.1 installers and checksums are in `release/tauri/`.

## 0.4.0 Rust + Tauri migration

- Default development, build and packaging commands now use Tauri 2. React/TypeScript is retained; desktop services are implemented in Rust with no Electron or Node.js runtime in the Tauri package.
- Rust implements local/SFTP/FTP/explicit FTPS endpoints, server trust, profiles, OS credentials, sessions, queued transfers, editor recovery, comparisons and conflict-protected saves.
- Public Electron profiles, SSH fingerprints and recovery copies are imported separately; remembered passwords require re-entry. Original Electron data is retained.
- Blue/slate themes and a two-pane transfer mark replace the green/leaf branding.
- Native verification passes on Windows and Ubuntu/WSL: 9 Windows / 10 Linux unit tests, 5 real-server protocol tests per platform, production desktop workflows and accessibility checks in both themes. Windows Credential Manager save/retrieve/delete also passes. Linux `.deb`/AppImage and Windows NSIS packages are built under `release/tauri/` with checksums.
- See [TAURI_MIGRATION.md](TAURI_MIGRATION.md) for commands, evidence and remaining qualification. Do not interpret the older Electron test results as Rust parity evidence.

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

## Milestone status (0.3.0 Electron prototype)

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

## Verification performed (0.3.0 Electron prototype)

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

The measurements above describe the Electron prototype. On 26 October 2026, Rust + Tauri was confirmed and implementation began. The default working-tree runtime now uses Tauri; settled native idle/startup and package measurements are still required to establish the lightweight goal. See [ARCHITECTURE.md](ARCHITECTURE.md).

## Next useful work

The user confirms the earlier qualification checklist complete for 0.4.6. Remaining work is release preparation: verify the new About/updater and automation changes, configure the website dispatch token, finish the licence/signing/distribution decisions and deliberately enable public downloads when ready. Optional additions such as SSH keys remain outside the agreed first-release scope.

See [RELIABILITY.md](RELIABILITY.md) for recovery instructions and known protocol limits.

## 27 October 2026 - 0.4.8 public preview

- Published v0.4.8 from eec5197 after both main and tagged Windows/Linux qualification passed. The sidebar reordering and single Appearance theme control are included.
- Native notices and matching project/crate/system source archives are required release assets. The AppImage inventory verifies library build IDs and exact Ubuntu source versions; reviewed runtime/launcher sources and notices are included.
- Backported the exact upstream GLib VariantStrIter fix for RUSTSEC-2024-0429. The optimized regression and native desktop checks pass; GitHub marks the advisory fixed.
- All 14 release assets are present, and all 13 manifest hashes match GitHub's upload digests. The website handoff passed, the live manifest shows 0.4.8, and Windows/DEB/RPM/AppImage links returned HTTP 200.
- Release: https://github.com/DrakonWolfDev/cosy-ftp/releases/tag/v0.4.8
- Release verification: https://github.com/DrakonWolfDev/cosy-ftp/actions/runs/40576474045
