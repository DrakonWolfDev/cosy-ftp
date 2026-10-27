# Public source repository readiness

Updated 27 October 2026. The repository is now public following owner approval and successful Windows/Linux hosted verification. Making the source public is separate from approving downloadable installers.

## Visibility checkpoint completed

- Hosted verification passed for commit `9606e5422e35f80780e4334dc937414d8aaa1929`: [Windows and Ubuntu run](https://github.com/DrakonWolfDev/cosy-ftp/actions/runs/40551422158). The headless Linux check uses software WebKit rendering and a D-Bus session.
- Private vulnerability reporting, dependency alerts, secret scanning and secret push protection are enabled. GitHub detects the AGPL licence.
- The latest targeted history scan inspected 207 blobs with no configured credential-pattern matches or tracked credential filenames. This remains a limited pattern scan.
- `WOLF_FORGE_SITE_TOKEN` is configured; its dispatch permissions have not yet been exercised.
- `COSY_FTP_RELEASE_APPROVED` remains unset. No release tag or public binary release was created. Native package notices and corresponding-source delivery remain outstanding.

## Prepared

- Full GNU AGPLv3 text in LICENSE, with `AGPL-3.0-only` metadata in package.json, package-lock.json and Cargo.toml. About states the licence. Native package configuration includes the licence and frontend notices.
- README includes the actual Cosy FTP logo/workspace, current preview status, build instructions, project website, licence and contributor/security links.
- CONTRIBUTING.md, SECURITY.md and a bug-report form are available. Repository description and website metadata are set.
- Current JavaScript notices are generated from the locked Tauri frontend packages; retained Electron generation has its own legacy mode. Native binary distribution requirements are explicitly tracked in THIRD_PARTY.md.
- A targeted scan of all locally reachable Git history inspected 182 file blobs and found no matches for the configured token/private-key/credential-URL patterns, and no tracked credential filenames. This is a limited pattern scan, not a complete security audit. Disposable test credentials are intentionally present in loopback fixtures; private keys are generated at runtime.
- Windows populated SFTP subdirectory failure was reproduced before the fix. The regression now verifies listing and reading `/nested/deeper/settings.json` with correct remote paths. All 28 Windows and 29 Linux backend/protocol tests pass.
- Final Windows native desktop workflows and both-theme workspace/About accessibility pass with the current embedded source fingerprint. TypeScript, production UI build and release-contract tests pass. Online npm audit reports zero vulnerabilities for the current lockfile. This does not establish a Rust/native dependency audit.

## Visibility-change checklist (historical preparation)

1. Deliberately change the repository to public only after owner approval. This preparation does not change visibility or publish a binary release.
2. Enable GitHub private vulnerability reporting and verify that SECURITY.md's private-report link works. GitHub exposes this feature for public repositories; the enablement endpoint returned 404 while this repository was private. Until enabled, the security policy provides the Wolf Forge contact fallback. See [GitHub's instructions](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository).
3. Review the security features GitHub makes available for the now-public repository, including secret scanning/push protection and dependency alerts.
4. Check README rendering, licence detection and the public project page. Keep the website entry on On the Workbench, with disabled download controls.

## Before binary publication

Keep `COSY_FTP_RELEASE_APPROVED` unset. Complete native package licence/notice and corresponding-source delivery review for the exact shipped artifacts, then verify the configured `WOLF_FORGE_SITE_TOKEN` can send the website release event. Follow [RELEASE.md](RELEASE.md). Installers built before the latest source changes are not qualified by the source-readiness checks.

Hosted CI status is separate from the local evidence above. Confirm the checks attached to the final pushed commit before tagging any release. No version tag is created by this preparation.

## 0.4.8 binary release preparation

The owner authorized completing distribution preparation and publishing 0.4.8. Both lockfiles and native/package versions are updated together. Native notices and source archives are generated from each target?s locked dependency resolution, with exact-revision upstream notice supplements where crates omit their licence files. Windows WebView2 SDK loader notices are included. Linux distribution preparation inventories actual AppImage ELF payloads, verifies build IDs against installed packages and archives the corresponding exact Ubuntu source packages plus runtime/launcher sources. The publication contract refuses missing source/notice assets. Release approval is enabled only for the verified publication attempt. Hosted verification and website handoff must still be confirmed for the release commit.
