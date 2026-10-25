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

This preview is unsigned. Existing destinations are protected unless replacement is confirmed. Some servers refuse staged replacement. Folder operations are not transactions. Delete supports files, links and empty directories. SSH keys/agents, automatic resume, full metadata preservation and direct server-to-server transfers are not included.

Electron's footprint still needs review against the lightweight goal. Validate important workflows with backed-up data before relying on the preview for production files. See [PROGRESS.md](PROGRESS.md), [SCOPE.md](SCOPE.md) and [RELIABILITY.md](RELIABILITY.md).
