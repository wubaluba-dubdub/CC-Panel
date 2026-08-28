#!/usr/bin/env bash
# One-time WSL environment setup for the panel project.
# Sources nvm, installs Node 22, verifies toolchain.
set -e

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

echo "=== Installing Node 22 ==="
nvm install 22
nvm use 22

echo "=== Toolchain versions ==="
echo "node: $(node -v)"
echo "npm:  $(npm -v)"
echo "g++:  $(g++ --version | head -1)"
echo "python3: $(python3 --version)"

echo "=== Done ==="
