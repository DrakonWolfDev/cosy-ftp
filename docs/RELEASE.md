# Cosy FTP release preparation

## Current status

On 27 October 2026, Andrew confirmed the 0.4.6 qualification work through release preparation complete, including use on Windows, Linux Mint and Fedora. This is user-reported field evidence; the older automated fixture reports remain historical evidence. The new 0.4.7 work adds About, Wolf Update and release automation and requires its own verification.

## Wolf Update

About Cosy FTP shows the Cosy FTP logo, version, credits, the small A WOLF FORGE PROJECT paw-print signature and update controls. The native Rust implementation follows the notification-only Wolf Update policy used by Wolf Launcher and AMP: the experimental channel includes published previews, skips drafts, compares versions, remembers dismissed versions and checks at most daily automatically. A manual check bypasses throttling and dismissal. Automatic checks can be disabled in About.

Checks contact only the official repository's GitHub Releases endpoint, with a 10-second timeout and a 2 MiB response limit. Release notes are displayed as text. No credentials, profiles or file contents are sent. View update opens only `https://wolf-forge.co.uk/cosy-ftp.html`; the app does not download or execute installers. State is stored in `wolf-update.json` alongside application data. The automatic-check preference is stored with the interface preferences.

## GitHub Actions

Pushes to main, pull requests and manual runs execute the existing Windows/Linux native verification and packaging workflow. Packages include Windows NSIS, Linux DEB, RPM and AppImage, plus checksums. The tagged-release workflow reuses these checks rather than publishing untested local files.

Before publishing a version:

1. Decide public repository visibility before enabling downloads. The repository is currently private; unauthenticated Wolf Update checks and public GitHub downloads cannot access private releases. About displays a clear not-yet-published message in this state. No token is embedded in the app. The release workflow refuses publication while the repository is private.
2. Set matching versions in package.json, package-lock.json, Cargo.toml/Cargo.lock and tauri.conf.json; commit and push main.
3. Configure `WOLF_FORGE_SITE_TOKEN` in the Cosy FTP repository. It needs permission to send `repository_dispatch` events to `DrakonWolfDev/wolf-forge-static`, as in Launcher and AMP.
4. Set repository variable `COSY_FTP_RELEASE_APPROVED=true` when public downloads are ready. Leave it unset while downloads must remain Coming soon. This is the equivalent of AMP's binary-release switch.
5. Push the matching `vX.Y.Z` tag. The workflow validates readiness/version agreement, runs the Windows/Linux tests and builds, requires exactly one of each of the four package formats, and publishes a GitHub prerelease with generated notes and SHA-256 checksums.
6. Only after publication succeeds, the workflow sends a `cosy_ftp` website event with the exact artifact names. The website validates the contract and checks that files exist before committing its manifest update. If dispatch fails after publication, fix the token and resend the event; do not recreate the release.

Public artifact names: `cosy-ftp-X.Y.Z-windows.exe`, `cosy-ftp-X.Y.Z.deb`, `cosy-ftp-X.Y.Z.rpm`, `cosy-ftp-X.Y.Z.AppImage`.

The website page remains in On the Workbench until separately moved by an explicit editorial change. No release event moves it to Out in the Wild. Its initial manifest is unavailable and its download controls are disabled. No tag or public binary release is part of this preparation.
