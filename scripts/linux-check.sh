#!/usr/bin/env bash
set -euo pipefail
# Run from .test-artifacts/linux/source after prepare-linux-copy.py. Keep Linux
# native dependencies separate from the Windows node_modules tree.
export PATH="$(pwd)/../tools/node/bin:$PATH"
export PYTHON="$(pwd)/../tools/venv/bin/python"
export COSY_PROTOCOL_TESTS=1
export COSY_TEST_DISABLE_SANDBOX=1
npm ci --cache ../tools/npm-cache
npm run check
xvfb-run -a npm run test:desktop
npm run package
