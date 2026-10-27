# v1 scope and behaviour

## Product

A calm desktop file manager for Windows 11 x64 and mainstream Linux x64 distributions with a graphical desktop. Windows 10 compatibility is unverified. Two independent panes can show local storage or separate remote sessions. Target an installable personal-use beta first, followed by a validated v1.

## Protocols and credentials

- SFTP over SSH with password authentication initially; pin SHA-256 host-key fingerprints after explicit first-use confirmation. Changed keys are refused. Private-key authentication is follow-up work.
- Explicit FTPS with normal certificate and hostname validation. Verified self-signed/private certificates and name mismatches can be approved through an explicit, host/port-scoped SHA-256 certificate pin. Replacements require review; expired certificates are refused. No blanket ignore-certificate switch.
- Plain FTP is opt-in per connection and visibly identified as unencrypted.
- Store passwords only when requested and the operating system provides a secure credential backend: Windows Credential Manager or Linux Secret Service. Otherwise prompt each session; never fall back to plaintext storage.
- Profiles contain no plaintext passwords. No protocol debug logging of authentication traffic.

## Files and transfers

- Browse local and remote directories; create folders, rename and delete after explicit confirmation.
- Copies between all endpoint combinations; bounded streaming through the client for remote-to-remote transfers. Same-server moves use rename when supported.
- Sequential queue with progress, cancellation and retry. Never silently retry destructive operations.
- Default: refuse existing destination files. Replacement requires explicit user selection. Stage each file beside its destination, then rename; do not delete the existing destination to force replacement. Some servers refuse replacement; report that safely.
- Check for source/destination overlap. Do not follow symbolic links during recursive copies or delete their targets. Unsupported file types are reported.
- Cancellation preserves files already committed, removes staging files where possible, and reports cleanup failures. No automatic partial-file resume in this version.
- Directory operations are not transactions: earlier completed files remain after a later failure. The queue and documentation must say this.

## Editor

Built-in plain text editor for UTF-8 files up to 2 MiB, explicit save to server, durable local recovery copies, and content-based conflict detection. Binary/non-UTF-8 files are refused. No automatic upload, executable preview, or rendering of remote HTML. Syntax highlighting and external editors are later improvements.

Comparison presents a fresh original beside the editable draft. Explicit review can update the draft's comparison baseline only if that original is still current; review never uploads. A subsequent save performs normal conflict checks again. Draft export writes a separate local copy without marking the original saved. Failed recovery writes trigger a quit warning while the latest text exists only in memory.

## Release exclusions

Direct server-to-server transfer, FTP active mode, implicit FTPS, SSH agents/keys/jump hosts, permission editing, synchronisation, scheduled transfers, automatic update service, large-file editor, and transactional directory transfers. Signing and distribution validation remain release gates, not implied by a local build.
