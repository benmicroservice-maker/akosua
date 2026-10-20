#!/usr/bin/env python3
"""Apply Akosua's fork patch set to a pristine microsoft/vscode clone.

Usage: python3 fork/apply_fork.py <vscode-src-dir>

What it does (inventory in FORK_PATCHES.md):
  1. Copies fork/contrib/akosua/ into src/vs/workbench/contrib/akosua/
  2. Adds ONE import line to src/vs/workbench/workbench.desktop.main.ts
Idempotent: safe to re-run after upstream syncs. ASCII output only (Windows
cp1252 lesson). This script is invoked by scripts/ci-build-windows.ps1 and
scripts/install-into-codeoss.* after the rebrand step.
"""
import pathlib, shutil, sys

def main() -> int:
    if len(sys.argv) < 2:
        print("usage: apply_fork.py <vscode-src-dir>")
        return 2
    root = pathlib.Path(sys.argv[1]).resolve()
    here = pathlib.Path(__file__).resolve().parent
    src = here / "contrib" / "akosua"
    dst = root / "src" / "vs" / "workbench" / "contrib" / "akosua"
    if not (root / "src" / "vs" / "workbench").exists():
        print(f"[fork] {root} does not look like a vscode clone")
        return 1
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(src, dst)
    n = sum(1 for _ in dst.rglob("*") if _.is_file())
    print(f"[fork] copied contrib/akosua ({n} files)")

    main_ts = root / "src" / "vs" / "workbench" / "workbench.desktop.main.ts"
    text = main_ts.read_text(encoding="utf-8")
    imp = "import './contrib/akosua/browser/akosua.contribution.js';"
    if imp not in text:
        marker = "//#region --- workbench contributions"
        if marker in text:
            text = text.replace(marker, marker + "\n\n// Akosua (fork): native agent UI — DESIGN.md UI-2\n" + imp, 1)
        else:  # fallback: append near other contrib imports
            anchor = "import './contrib/"
            idx = text.find(anchor)
            if idx < 0:
                print("[fork] ERROR: no contrib import anchor found in workbench.desktop.main.ts")
                return 1
            text = text[:idx] + imp + "\n" + text[idx:]
        main_ts.write_text(text, encoding="utf-8")
        print("[fork] registered akosua.contribution in workbench.desktop.main.ts")
    else:
        print("[fork] contribution import already present")
    print("[fork] OK")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
