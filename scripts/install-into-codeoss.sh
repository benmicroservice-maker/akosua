#!/usr/bin/env bash
# Bash twin of install-into-codeoss.ps1 (Linux/CI/sandbox verification).
set -euo pipefail
VSCODE_PATH="${1:?usage: install-into-codeoss.sh /path/to/vscode-clone}"
SRC="$(cd "$(dirname "$0")/.." && pwd)"
cp -r "$SRC/extensions/akosua" "$VSCODE_PATH/extensions/akosua"
cp -r "$SRC/akosua-core" "$VSCODE_PATH/akosua-core"
rm -rf "$VSCODE_PATH/extensions/akosua/node_modules" "$VSCODE_PATH/extensions/akosua/out" \
       "$VSCODE_PATH/akosua-core/node_modules" "$VSCODE_PATH/akosua-core/dist"
echo "Akosua installed into $VSCODE_PATH (extensions/akosua + akosua-core)"
