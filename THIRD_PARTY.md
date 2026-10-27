# Third-party components

Cosy FTP's original project source is licensed AGPL-3.0-only. Dependencies keep their own licences; the project licence does not relicense them.

## Frontend

`node scripts/third-party-notices.cjs` regenerates `build/THIRD_PARTY_NOTICES.txt` from the installed, locked React, React DOM, Lucide and Tauri API packages and their JavaScript dependencies. The file includes upstream licence and notice texts. Run `npm ci` first. The retained Electron build uses `--legacy` to include its different JavaScript backend dependencies.

## Native runtime and packages

`src-tauri/Cargo.lock` pins the Rust dependency graph. Native components include Tauri/Wry and their platform webview integrations, libssh2, OpenSSL, FTP/TLS transports and credential-store integrations. Platform packages can also redistribute native shared libraries. The frontend notice file is not a complete native distribution notice set.

Before publishing binary downloads, inventory the exact Windows, DEB, RPM and AppImage contents and collect the required licence/notice texts for the actual redistributed versions. Account for statically bundled components and any system libraries included inside AppImage. Where a component requires corresponding source, replacement/relinking materials or other delivery materials, provide those alongside the release and document how they were produced. Keep the matching Cosy FTP source commit and reproducible build instructions available with the binaries.

This native distribution review remains a binary-release task. Publishing this source repository does not certify the existing local installers for public redistribution. Keep `COSY_FTP_RELEASE_APPROVED` unset until the exact release artifacts and their source/notice delivery are ready.
