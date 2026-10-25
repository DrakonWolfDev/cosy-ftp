# Calm FTP Client — Project Ideas

Discussion notes saved on 25 October 2026. This is an early concept, with no final product name or implementation decisions yet.

## Aim

Build a lightweight, calm-looking file transfer client for Windows and Linux as a more comfortable alternative to FileZilla. Prioritise readable text, restrained colours, comfortable spacing, and straightforward everyday actions.

## Interface

- Two file browser panes, each independently showing local files or a remote session.
- A connection selector and path bar for each pane.
- Saved connections in a small sidebar.
- Muted dark and warm light themes.
- A compact transfer queue that expands when needed.
- Clear progress and error messages, with detailed connection logs tucked away.

## Connection and transfer modes

### Local to remote

Normal uploads and downloads, including drag and drop between panes.

### Two locations on the same remote server

Open the same saved connection in both panes and browse different directories. Drag files between them to organise the remote machine.

Moves can usually use a server-side rename/move operation without downloading file contents. Moves across filesystems may require a different approach. Server-side copying depends on protocol and server capabilities; the client must distinguish copying from moving clearly.

### Two different remote servers

Drag from one remote pane to the other without manually downloading and then uploading files.

The broadly applicable approach is to stream chunks through the client: receive from server A and forward to server B. This removes the manual intermediate step and does not require a complete temporary file, but traffic still passes through the user's computer and connection.

Direct server-to-server transfer is a separate capability. It requires suitable server access and support; ordinary FTP or SFTP access alone does not guarantee it. Treat this as a possible later feature.

Show a small, clear status such as “Moving on server” or “Transferring through this computer” so the user understands the operation.

## Remote file editing

Open a remote text file, edit it, and save it back without manually managing downloads and uploads. Behind the scenes, the client downloads a temporary working copy and uploads changes on save.

Possible editor options:

- Built-in tabbed text editor with syntax highlighting, line numbers, search/replace, and an unsaved-change indicator.
- External editor integration, such as VS Code, with save detection and either automatic upload or an upload prompt according to user preference.

Reliability requirements:

- Detect remote changes before overwriting where practical, and warn about conflicts.
- Preserve the local working copy if the connection drops or an upload fails.
- Distinguish saving locally from successfully saving to the server.
- Where supported, upload to a temporary remote file and rename it into place to reduce the risk of partial writes. Account for permissions and server replacement behaviour.

Start with text files, explicit save/upload, and a clear “Saved to server” indicator. Typical uses include configuration files, HTML, CSS, and scripts. Large files and logs would need appropriate limits or separate viewing behaviour.

## Technical direction

Use established transfer libraries rather than implementing protocols from scratch. FTP, FTPS, and SFTP need distinct handling; SFTP is a separate protocol from FTP.

Candidate desktop approaches:

| Approach | Advantages | Tradeoffs |
| --- | --- | --- |
| Rust + Tauri | Potentially lightweight, with extensive control over interface styling | Integration work between the web interface and transfer backend |
| Qt with Python or C++ | Well suited to desktop file browsers and split panes | Styling needs care; Python packaging adds weight |
| Electron | Flexible interface development using web technologies | Typically larger downloads and higher memory use |

Initial preference from the discussion: explore Rust + Tauri, with Qt as another strong candidate. This is provisional and should be validated against transfer-library support, packaging, and development needs.

## Suggested first version

- Windows and Linux support.
- Saved connections and secure credential storage using platform facilities where available.
- Two independent panes supporting local and remote browsing.
- Upload, download, rename, delete, and a transfer queue.
- Two remote sessions, including separate directories on the same server.
- Remote-to-remote transfers streamed through the client.
- Basic remote text editing with explicit upload and recovery of unsaved work.

Choose the initial protocol coverage before implementation. Broader compatibility, reconnect behaviour, interrupted transfers, large directory trees, symbolic links, permissions, filename encodings, and conflict handling are the main sources of complexity.

## Rough effort discussed

For an experienced developer, a working prototype could take several days, a pleasant personal-use version a few weeks, and broader reliability and polish several months. These are exploratory estimates, not a delivery commitment; protocol coverage and editing requirements will affect scope substantially.

## Product principle

Focus on a handful of servers used regularly and make the common actions excellent. Keep advanced details available without crowding the everyday interface.
