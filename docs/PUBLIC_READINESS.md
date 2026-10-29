# Public source repository readiness

Updated 27 October 2026. The repository is now public following owner approval and successful Windows/Linux hosted verification. The 0.4.8 preview is now published with verified installers, notices and matching sources.

## 0.5.0 beta release authorization - 29 October 2026

The owner authorized committing, pushing and publishing 0.5.0 beta after local Windows/Debian test builds. UI/type checking and queue/selection/estimate regression tests passed. The tagged pipeline must pass native Windows/Linux verification, package/source/notice checks and publication before this version is considered released. Build status will be checked at spaced intervals.

## Unreleased fixes verified 29 October 2026

- FTP/FTPS downloads reconnect and retry only the current uncommitted file after recognised socket failures. Replacement connections use baseline `LIST` metadata checks instead of re-probing `STAT`.
- The owner confirmed the previously failing bulk download completes with test build 6. The underlying connection abort is still unexplained; recovery handles the tested case.
- Local non-empty folder deletion now removes nested contents after explicit confirmation, without following symbolic links or junctions. Owner testing confirmed deletion works.
- Validation passed: 27 backend unit tests; FTP/FTPS forced-disconnection recovery and bounded-failure checks; separate 1,000-file FTP and FTPS downloads; metadata fallback checks; Windows directory-junction preservation; production UI and Windows release builds. The FTPS bulk regression covered TLS 1.3 with 3,000 resumed protected data connections and no reconnects on loopback.
- Persistent diagnostic logs retain transfer errors and connection steps. Temporary binaries and private server logs are excluded from source control. No release has been published for these fixes.

## 0.4.8 publication completed

- Published [0.4.8 preview](https://github.com/DrakonWolfDev/cosy-ftp/releases/tag/v0.4.8) from commit `eec51975ed4373fe7dccd05ada299ec94a5bcbf2`.
- Both platforms passed [main verification](https://github.com/DrakonWolfDev/cosy-ftp/actions/runs/40568746895) and [tagged release verification/publication](https://github.com/DrakonWolfDev/cosy-ftp/actions/runs/40576474045).
- All four packages, three source archives, full notices and native inventories are published: 14 assets including SHA256SUMS.txt. All 13 manifest checksums were compared successfully with GitHub's uploaded-file digests.
- The [website handoff](https://github.com/DrakonWolfDev/wolf-forge-static/actions/runs/40581193795) passed and committed manifest update `4bb9bc262688ca6936f4135724a4f343826fc64c`. The live website reports 0.4.8, and all four download links returned HTTP 200.
- `WOLF_FORGE_SITE_TOKEN` dispatch permissions have been exercised successfully. `COSY_FTP_RELEASE_APPROVED=true` enables the guarded tagged-release pipeline.
- Native source/notice delivery is implemented as described in THIRD_PARTY.md. The GLib security backport has an optimized regression test; GitHub marks the advisory fixed. The npm audit reported zero vulnerabilities.

## Visibility checkpoint completed (historical)

- Hosted verification passed for commit `9606e5422e35f80780e4334dc937414d8aaa1929`: [Windows and Ubuntu run](https://github.com/DrakonWolfDev/cosy-ftp/actions/runs/40551422158). The headless Linux check uses software WebKit rendering and a D-Bus session.
- Private vulnerability reporting, dependency alerts, secret scanning and secret push protection are enabled. GitHub detects the AGPL licence.
- The latest targeted history scan inspected 207 blobs with no configured credential-pattern matches or tracked credential filenames. This remains a limited pattern scan.
- `WOLF_FORGE_SITE_TOKEN` was configured at this checkpoint; its permissions were subsequently verified by the 0.4.8 handoff.
- At this source-visibility checkpoint, release approval was unset and binary distribution preparation remained outstanding. Those items were subsequently completed for 0.4.8 as recorded above.

## Earlier preparation evidence

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

## Subsequent binary releases

The release approval switch is enabled. For each new version, regenerate and verify the native package notices and matching sources for its exact artifacts, and retain the publication and website checks. Follow [RELEASE.md](RELEASE.md). Installers built before the latest source changes are not qualified by the source-readiness checks.

Hosted CI status is separate from the local evidence above. Confirm the checks attached to the final pushed commit before tagging any release. The initial visibility preparation created no tag; the separately authorized 0.4.8 publication is recorded above.

## 0.4.8 binary release preparation

The owner authorized completing distribution preparation and publishing 0.4.8. Both lockfiles and native/package versions are updated together. Native notices and source archives are generated from each target's locked dependency resolution, with exact-revision upstream notice supplements where crates omit their licence files. Windows WebView2 SDK loader notices are included. Linux distribution preparation inventories actual AppImage ELF payloads, verifies build IDs against installed packages and archives the corresponding exact Ubuntu source packages plus runtime/launcher sources. The publication contract refuses missing source/notice assets. Release approval is enabled only for the verified publication attempt. Hosted verification and the live website handoff passed for the release commit, as linked above.

GitHub advisory RUSTSEC-2024-0429 is addressed by vendoring the required GLib 0.18.5 bindings and applying the exact upstream pointer-mutability fix from gtk-rs-core#1343. The optimized forward/reverse string-iteration regression passes locally and is required in Linux CI. The vendored source and patch provenance are included in matching source snapshots and the native build fingerprint.
