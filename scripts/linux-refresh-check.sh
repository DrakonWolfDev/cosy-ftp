#!/usr/bin/env bash
set -euo pipefail
# Reuse the isolated native build after linux-native-check.sh has finished.
cosy_workspace="$(pwd)"
cosy_target="$(cat .test-artifacts/linux/native-path.txt)"
case "$cosy_target" in */.cache/cosy-ftp-check.*) ;; *) exit 1 ;; esac
tar -cf - electron shared src scripts tests docs build package.json package-lock.json \
  tsconfig.json tsconfig.backend.json tsconfig.tests.json vite.config.ts index.html \
  README.md MILESTONES.md .prettierrc.json | tar -xf - -C "$cosy_target"
export PATH="$cosy_workspace/.test-artifacts/linux/tools/node/bin:$PATH"
cd "$cosy_target"
export PYTHON="$cosy_target/.venv/bin/python"
export COSY_PROTOCOL_TESTS=1 COSY_TEST_DISABLE_SANDBOX=1 CSC_IDENTITY_AUTO_DISCOVERY=false
npm run check
npm run dist -- --publish never
xvfb-run -a npm run test:packaged
mkdir -p "$cosy_workspace/release/linux" "$cosy_workspace/.test-artifacts/linux/desktop"
cp release/*.AppImage release/*.deb "$cosy_workspace/release/linux/"
cp .test-artifacts/desktop/*.png .test-artifacts/desktop/metrics.json "$cosy_workspace/.test-artifacts/linux/desktop/"
