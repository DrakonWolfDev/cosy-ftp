#!/usr/bin/env bash
set -euo pipefail
cd .test-artifacts/linux/tools
curl -fsSL --retry 2 https://nodejs.org/dist/v24.19.0/node-v24.19.0-linux-x64.tar.xz -o node.tar.xz
curl -fsSL https://nodejs.org/dist/v24.19.0/SHASUMS256.txt -o SHASUMS256.txt
grep ' node-v24.19.0-linux-x64.tar.xz$' SHASUMS256.txt | sed 's/node-v24.19.0-linux-x64.tar.xz/node.tar.xz/' | sha256sum -c -
mkdir -p node
tar -xf node.tar.xz -C node --strip-components=1
python3 -m venv venv
venv/bin/pip install -r ../source/tests/requirements.txt
