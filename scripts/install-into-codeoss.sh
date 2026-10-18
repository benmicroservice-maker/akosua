#!/usr/bin/env bash
# Bash twin of install-into-codeoss.ps1 (Linux/CI/sandbox verification).
set -euo pipefail
VSCODE_PATH="${1:?usage: install-into-codeoss.sh /path/to/vscode-clone}"
SRC="$(cd "$(dirname "$0")/.." && pwd)"
cp -r "$SRC/extensions/akosua" "$VSCODE_PATH/extensions/akosua"
# Fork patch: register extensions/akosua in VS Code's npm install dirs list
python3 - "$VSCODE_PATH/build/npm/dirs.ts" << 'PYEOF'
import pathlib, sys
f = pathlib.Path(sys.argv[1]); t = f.read_text()
if "extensions/akosua" not in t:
    t = t.replace("'extensions/configuration-editing',", "'extensions/akosua',\n\t'extensions/configuration-editing',", 1)
    f.write_text(t)
PYEOF
cp -r "$SRC/akosua-core" "$VSCODE_PATH/akosua-core"
rm -rf "$VSCODE_PATH/extensions/akosua/node_modules" "$VSCODE_PATH/extensions/akosua/out" \
       "$VSCODE_PATH/akosua-core/node_modules" "$VSCODE_PATH/akosua-core/dist"
echo "Akosua installed into $VSCODE_PATH (extensions/akosua + akosua-core)"
