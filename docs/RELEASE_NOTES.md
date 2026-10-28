# 0.4.9 beta.1 — recursive-delete hotfix

- Non-empty folders can now be deleted recursively after explicit confirmation.
- Delete planning covers the full selection before removal, with 100-level and 100,000-item safety limits.
- Symbolic links are removed without following their targets.
- Removed the obsolete Electron runtime implementation, legacy Node protocol dependencies and stale development scripts. Existing Electron profiles, fingerprints and recovery copies can still be imported once.
- Promoted the product status from development preview to beta.

This remains an unsigned beta. Deletion is permanent and folder operations are not transactions; use backed-up data while testing.

# 0.4.7 - source preview and release preparation

27 October 2026. Public installer downloads are not yet enabled.

- About shows Cosy FTP's existing transfer logo and the small Wolf Forge paw-print project signature.
- Wolf Update checks published GitHub releases, including previews, with manual checks, optional daily checks and remembered version dismissal. Opening an update visits the official project page; installation stays manual.
- Fixed populated SFTP subdirectory listings on Windows, with real-server nested-directory list/read coverage.
- Added Windows/Linux verification and gated tagged-release automation for NSIS, DEB, RPM and AppImage packages, checksums and the website download event.
- Licensed the original project under AGPL-3.0-only and added public contribution/security guidance. Native binary redistribution review remains separate from publishing the source.
- The Wolf Forge project page uses actual app screenshots and stays on the workbench with Coming soon downloads.

# 0.3.0 — conflict review and draft rescue

25 October 2026.

- Compare a changed original with your local draft and explicitly review merged text before saving. Stale comparisons are refused and review never uploads automatically.
- Save a separate local draft copy even when disconnected or recovery writes fail. Export preserves the original binding and unsaved state.
- Warn before quitting with failed recovery writes, allowing in-memory text to be rescued.
- View and forget trusted SSH fingerprints through the sidebar, with disconnect and confirmation checks. Changed keys still require verification; FTPS checks stay enabled.
- Keep sidebar tools and queue controls accessible in compact windows.

The release remains an unsigned preview with the limits described below.

# 0.2.0 — connection recovery and everyday browsing

25 October 2026.

- Reconnect dropped remote browsing sessions without losing their identity, pane location or editor bindings.
- Sort columns and Shift/Ctrl selection in either file pane.
- A clearly labelled Appearance dialog, with theme persistence tested across app restarts.
- Clear FTPS certificate guidance, retaining certificate verification.
- Real network-interruption and cancellation tests verify original-file protection and staging cleanup.

The release remains an unsigned preview with the limits described below.

# 0.1.0 — development preview

First working Cosy FTP desktop implementation, 25 October 2026.

- Two independent local/remote panes, saved connections, dark and warm light themes.
- SFTP, explicit FTPS and opt-in unencrypted FTP, with SSH trust and normal TLS certificate validation.
- Queued file/folder copies, streamed remote transfers and same-server moves.
- UTF-8 editing with explicit save/upload, conflict protection and local draft recovery.
- Windows/Linux preview packages, protocol tests, desktop automation and accessibility checks.

This preview is unsigned. Existing destinations are protected unless replacement is confirmed. Some servers refuse staged replacement. Folder operations are not transactions. Confirmed deletes support files, links and bounded recursive folder removal. SSH keys/agents, automatic resume, full metadata preservation and direct server-to-server transfers are not included.

The application now ships on Rust/Tauri without the Electron runtime. Validate important workflows with backed-up data before relying on the preview for production files. See [PROGRESS.md](PROGRESS.md), [SCOPE.md](SCOPE.md) and [RELIABILITY.md](RELIABILITY.md).
