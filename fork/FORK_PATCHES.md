# Akosua Fork Patch Inventory

Every delta we apply to a pristine `microsoft/vscode` clone, in one place —
this is how monthly upstream merges stay survivable (HARNESS/DESIGN rule:
changes confined, enumerated, idempotent).

| # | Patch | Applied by | Files touched in clone |
|---|---|---|---|
| 1 | product.json rebrand (names, folders, gallery) | `scripts/rebrand_to_akosua.py` | `product.json` |
| 2 | Akosua icons (`code.ico`, tiles) | `scripts/rebrand_to_akosua.py` (assets from `brand/`) | `resources/win32/code.ico`, `code_70x70.png`, `code_150x150.png` |
| 3 | Installer filename `AkosuaSetup` | `scripts/rebrand_to_akosua.py` | `build/win32/code.iss` (`OutputBaseFilename`) |
| 4 | Register `extensions/akosua` in npm install dirs | `scripts/install-into-codeoss.*` | `build/npm/dirs.ts` (1 line) |
| 5 | Copy `@akosua/core` beside the extension | `scripts/install-into-codeoss.*` / CI | `akosua-core/` (new dir), `extensions/akosua/` (new dir) |
| 6 | **Native UI (UI-2)** | `fork/apply_fork.py` | `src/vs/workbench/contrib/akosua/**` (new), 1 import in `src/vs/workbench/workbench.desktop.main.ts` |

Rules:
- New fork code lives ONLY under `contrib/akosua/` (patch 6). Shared VS Code
  files get at most one-line registrations.
- Every patch script is idempotent and prints ASCII only.
- If an upstream sync conflicts, the fix updates THIS file and the patch
  script — never hand-edits inside CI.
