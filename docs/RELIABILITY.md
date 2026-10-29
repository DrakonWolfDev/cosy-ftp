# Reliability, recovery and beta limits

The working tree now uses Rust + Tauri. See [TAURI_MIGRATION.md](TAURI_MIGRATION.md) for native verification and remaining qualification; older Electron test evidence does not establish Rust parity.

## Copies and moves

Copies stream through the client with bounded buffers. Every file is written beside its destination under a random `.cosy-<uuid>.part` name, checked for size/source metadata changes, then committed by rename. Existing files are refused by default. Replacing a file is explicit; the client never deletes the original to force a failed rename to succeed. Not all FTP/SFTP servers support replacement.

The queue is sequential, held in memory, and not automatically resumed after restart. Retry repeats the entire operation. In a partially completed folder copy, already completed files remain; a retry without replacement may encounter those files. Cancelled transfers attempt staging cleanup; a fresh connection is used if necessary. If cleanup still fails, the queue reports the staging path. It can be removed after checking that it is an incomplete transfer. An abrupt process kill or power failure can also leave staging files.

Use **Reconnect session** in a failed remote pane, or the reconnect icon under Open sessions, to restore browsing after a connection drop. This preserves the session ID and pane path, and keeps editor copies bound to the session. It uses the existing session credentials and server trust checks. Active transfers use their own connections; reconnecting the browser does not restart a failed transfer. Use the queue's explicit Retry action after checking any already completed files.

Folder copies preflight unsupported types/conflicts before creating folders, and cap recursion at 100 levels / 100,000 entries. Links and special files are refused, not dereferenced. Parent paths are canonicalised before overlap checks. Recursive delete preflights the full selection with the same 100-level / 100,000-item limits. Local symbolic links and junctions are removed without following their targets.

## Concurrent changes

During FTP downloads to local storage, recognised socket failures trigger up to two reconnections for the current uncommitted file. Staging cleanup must succeed before retrying. Progress from discarded staging copies is rolled back; completed files are retained. This recovery does not resume a queue after application restart or retry uploads.

FTP metadata checks prefer LIST-style `STAT` replies over the existing control connection, retaining fresh link/type, size and time checks without opening a data socket for each check. Servers with unsupported commands or formats fall back to `LIST` for that connection. Directory listings still use `LIST`.

Text saves compare SHA-256 content hashes both before upload and immediately before commit. Copies compare source size and modification time before commit. This detects many conflicts, but FTP and ordinary SFTP do not provide an atomic compare-and-swap operation: another writer can still change a path between the final check and rename. FTP no-overwrite behaviour is also server-dependent if another writer races the existence check. Do not treat this beta as a concurrent synchronisation tool.

## Permissions and ownership

Local and SFTP saves preserve ordinary permission bits when the endpoint supports them; new copies use source permission bits where available. Special setuid/setgid/sticky bits are not propagated. Staged replacement can change ownership, ACLs, hard-link relationships, extended attributes and server-specific metadata. FTP has no portable way to preserve all of those attributes; new files inherit server defaults. Verify permissions after editing deployment/configuration files. Full metadata preservation is a release gate, not a current guarantee.

## Editor recovery

Working copies and their original content hashes are persisted under the application's user-data `recovery/` directory. Draft changes are sent immediately to the main process and serialised to atomic JSON writes. A visible “Working copy saved locally” status means the recovery write completed; it does not mean the server was changed. Only “Saved to server” follows a successful remote commit. Failed saves retain the draft.

After restart, open the editor strip. For remote drafts, reconnect the same saved connection and choose **Use reconnected session** before saving. The server identity and original content are checked again. Changed connection details cannot silently redirect an old draft to another server. Recovery files contain your text in plaintext under your own OS account, like a normal editor recovery folder; they are not encrypted. Close/discard a working copy to remove it.

When a conflict is reported, **Compare original** reads the latest original and displays it beside your editable local draft. Merge changes manually, acknowledge the review, then choose **Keep reviewed draft**. The app reads the original again before accepting that review and refuses stale comparisons. Review updates only the local working copy's comparison baseline; it never uploads. Save remains explicit and repeats the normal checks, including the protocol race limitations above.

**Save copy as…** exports the latest draft to a local file chosen through the native save dialog. It is available without a remote connection and can rescue text when recovery writes have failed. Export does not clear the original's unsaved state or redirect its future saves. Export refuses the local original itself, hard-link and directory aliases to that same file, and symbolic-link destinations. Existing regular copy files can be replaced through the native save dialog's overwrite confirmation.

If recovery storage cannot accept the latest changes, the app warns before quitting. Choose **Keep working** and export a copy or repair the storage problem. Normally persisted drafts do not cause a quit warning. Force-killing the process or losing power can still lose changes that never reached recovery storage; an exported copy is separate from automatic recovery.

## FTPS certificate errors

Certificate approval happens before password authentication. Normal CA/hostname/date validation is attempted first. Self-signed/private certificates and name mismatches can be reviewed in a fingerprint dialog and explicitly pinned for that host and port. Replacements require review; expired or invalid server-authentication certificates are refused. Exception-mode data channels must present the accepted control certificate. Failure to save a trust decision prevents login. See [FTPS_CERTIFICATES.md](FTPS_CERTIFICATES.md).

## Credentials and trust

Profiles and SSH fingerprints live in `connections.json` under Tauri's application-data directory (`%APPDATA%/dev.cosyftp.desktop` on Windows, usually `~/.local/share/dev.cosyftp.desktop` on Linux). Passwords are remembered only on request in Windows Credential Manager or Linux Secret Service. If secure storage is unavailable, use session-only passwords. Different Linux keyring/desktop configurations still require field testing.

On first launch, public profiles, SSH fingerprints and recovery copies are imported from the Electron preview's data directory (`%APPDATA%/cosy-ftp` or `~/.config/cosy-ftp`). Those original files are retained. Remembered Electron passwords require re-entry because their encryption is specific to Electron. `COSY_USER_DATA` selects an isolated test directory and disables import.

SSH first-use trust requires a native confirmation with the SHA-256 fingerprint; subsequent mismatches are refused. **Trusted SSH servers** lists those fingerprints. If an administrator legitimately rotates a key, verify the replacement independently, disconnect the server's open sessions, then use **Forget trust** and confirm the removal. The next connection requires a new fingerprint confirmation. Forgetting a key preserves saved profiles and encrypted credentials; cancelling the confirmation preserves the fingerprint. FTPS certificate pins are managed separately under Trusted FTPS certificates; they never grant SSH trust. Plain FTP visibly warns that passwords and files are unencrypted.

## Release validation

On 27 October 2026, Andrew confirmed the 0.4.6 qualification checklist complete through release preparation, including Windows, Linux Mint and Fedora use. This is user-reported field evidence, separate from the automated loopback reports. The new 0.4.7 About/updater and release automation changes are verified separately; release setup is tracked in [RELEASE.md](RELEASE.md). The protocol and metadata limits described above continue to apply.
