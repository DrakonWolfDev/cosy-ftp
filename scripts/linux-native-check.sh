#!/usr/bin/env bash
set -euo pipefail
# Run from the repository root inside Ubuntu/WSL. Requires the tools created by
# linux-bootstrap.sh. Native cache storage avoids NTFS metadata overhead in WSL.
cosy_workspace="$(pwd)"
mkdir -p "$HOME/.cache"
cosy_target="$(mktemp -d "$HOME/.cache/cosy-ftp-check.XXXXXX")"
printf '%s\n' "$cosy_target" > .test-artifacts/linux/native-path.txt
tar -cf - electron shared src scripts tests docs build package.json package-lock.json \
  tsconfig.json tsconfig.backend.json tsconfig.tests.json vite.config.ts index.html \
  README.md MILESTONES.md .prettierrc.json | tar -xf - -C "$cosy_target"
export PATH="$cosy_workspace/.test-artifacts/linux/tools/node/bin:$PATH"
cd "$cosy_target"
python3 -m venv .venv
.venv/bin/pip -q install -r tests/requirements.txt
export PYTHON="$cosy_target/.venv/bin/python"
export COSY_PROTOCOL_TESTS=1
export COSY_TEST_DISABLE_SANDBOX=1
export CSC_IDENTITY_AUTO_DISCOVERY=false
npm ci --cache "$cosy_workspace/.test-artifacts/linux/tools/npm-cache"
npm run check
xvfb-run -a npm run test:desktop
npm run dist -- --publish never
xvfb-run -a npm run test:packaged
mkdir -p "$cosy_workspace/release/linux" "$cosy_workspace/.test-artifacts/linux/desktop"
cp release/*.AppImage release/*.deb "$cosy_workspace/release/linux/"
cp .test-artifacts/desktop/*.png .test-artifacts/desktop/metrics.json "$cosy_workspace/.test-artifacts/linux/desktop/"
