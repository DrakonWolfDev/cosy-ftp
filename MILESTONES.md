# Cosy FTP — delivery milestones

Recorded 25 October 2026. These milestones define a completed v1, not a delivery-date commitment. See [PROJECT_IDEAS.md](PROJECT_IDEAS.md) for the original concept and [docs/PROGRESS.md](docs/PROGRESS.md) for implementation evidence and remaining work.

| #   | Milestone                     | Acceptance criteria                                                                                                                                          |
| --- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Agree v1 scope                | Protocols, platform targets, editor, conflict rules and release limits documented.                                                                           |
| 2   | Validate technical foundation | Packaged application transfers files on Windows and Linux with every selected protocol.                                                                      |
| 3   | Build two-pane interface      | Independent panes, local browsing, paths, saved connections, themes, loading and error states work.                                                          |
| 4   | Secure remote connections     | Save profiles, securely connect, browse and reconnect; credentials stay out of logs and plaintext storage; server trust is checked.                          |
| 5   | Everyday file operations      | Upload/download, create directory, rename, delete, drag/drop and queue work; conflicts, retries, cancellation and incomplete files are handled.              |
| 6   | Two remote panes              | Same-server moves and streamed copies between servers work with meaningful progress and safe failure behaviour.                                              |
| 7   | Remote text editing           | Explicit upload, change detection, local recovery and accurate save status prevent silent loss of edits.                                                     |
| 8   | Harden and test               | Platform/protocol matrix, interrupted transfers, large trees, names, links, permissions, disk failures, accessibility and responsiveness pass release gates. |
| 9   | Package and release           | Clean installs on both platforms pass core workflows; distribution artifacts, quick start, release notes and limitations are ready.                          |

## Checkpoints

- Prototype: milestone 4; packaged two-pane browsing and connections.
- Feature-complete beta: milestone 7; all promised workflows function end to end.
- Completed v1: milestone 9; tested, recoverable, documented and distributable.

## Scope discipline

Prove protocol libraries and packaging before investing heavily in polish. Direct server-to-server transfers, advanced IDE editing, and large-log viewing are later work. Re-estimate after the platform/protocol spike; the original discussion's effort estimates are exploratory.
