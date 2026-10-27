# Third-party components

Cosy FTP's original source is licensed AGPL-3.0-only. Dependencies retain their own licences; the project licence does not relicense them.

## Notices and corresponding sources

Every public release at https://github.com/DrakonWolfDev/cosy-ftp/releases includes the Windows installer, Linux packages, SHA-256 checksums, native inventories, full dependency notices and matching source archives. Choose the release matching the installed app version.

- `NATIVE_THIRD_PARTY_NOTICES.txt` is installed with the app. Platform-specific copies are also published as `NATIVE_NOTICES_windows.txt` and `NATIVE_NOTICES_linux.txt`.
- `THIRD_PARTY_NOTICES.txt` contains the frontend JavaScript notices generated from the locked packages.
- `cosy-ftp-VERSION-windows-sources.tar.gz` and `cosy-ftp-VERSION-linux-sources.tar.gz` contain the matching project/build inputs, frontend dependencies and exact Cargo registry source archives, including nested OpenSSL, libssh2 and other native sources. Additional upstream licence files missing from published crates are preserved with their exact-revision provenance under `build/native-license-supplements`.
- `LINUX_SYSTEM_NOTICES.txt` contains copyright notices and licence texts for the libraries bundled inside the AppImage. `linux-payload-inventory.json` records their package versions and ELF build identities. DEB and RPM use operating-system libraries; the AppImage redistributes its listed libraries.
- `cosy-ftp-VERSION-linux-system-sources.tar.gz` contains the exact Ubuntu source packages (`.dsc`, original source and Debian patches/build recipes), AppImage runtime and launcher source revisions, generated launcher scripts and notices. The runtime's submodule sources are included.

MPL-covered dependency source is included in the platform archives with its original headers and licence. LGPL libraries in the AppImage are dynamically loaded. You may modify them and reverse engineer the combined work to debug those modifications as permitted by their licences. Extract with `--appimage-extract`, replace the relevant libraries under `squashfs-root/usr/lib`, and run `squashfs-root/AppRun`; there is no signature or installer restriction on replacement. The supplied project sources can also be rebuilt against replacement libraries.

## Rebuilding

See README.md for native prerequisites and npm/Cargo commands. Source archives include both lockfiles. Cargo `.crate` files are gzip-compressed tar archives containing the original source; extract them into a vendor tree with the supplied Cargo checksum files and configure source replacement as described in SOURCE-README.txt for offline native builds. Native distribution archives include their own source README.

For an Ubuntu source package, use `dpkg-source -x NAME.dsc`, install its declared build dependencies and run `dpkg-buildpackage` in the unpacked source. Each source package includes its Debian packaging and patches. Runtime sources include their upstream build scripts and submodules.

## Release checks

`python scripts/native-notices.py` must run before native packaging, after npm ci and Rust setup. It derives each target's dependency inventory from locked Cargo metadata and fails if licence text or a registry source archive is missing. Then package with `npm run dist`.

On the Ubuntu build host, enable deb-src before installing prerequisites. After packaging, run `python scripts/linux-distribution.py`. It traces bundled ELF files to installed packages, compares ELF build IDs, downloads exact matching source versions and checks their source archives through dpkg-source. Unknown libraries, changed payload identities, missing notices or unavailable sources stop publication. The release contract requires all supporting assets before it creates a website event.

The retained Electron build is not part of these native releases; its JavaScript notices use `node scripts/third-party-notices.cjs --legacy`.

## GLib security backport

The GLib 0.18.5 Rust binding is vendored with the exact two-line upstream fix for RUSTSEC-2024-0429 (gtk-rs-core#1343). Its original licence and a COSY-PATCH.md provenance record are retained. The modified source is included in the repository and platform archives; an optimized regression test runs in Linux CI. Other registry dependencies are supplied unmodified and checked against Cargo.lock source archive hashes.
