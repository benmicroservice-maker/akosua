# Akosua — Windows workstation setup for the Code-OSS fork
# Run in PowerShell (as your normal user; some installers will prompt for admin).
# This prepares everything needed to BUILD Akosua on Windows. Nothing here is needed on day 1
# except Git + cloning — the agent will tell you when to run each step.

$ErrorActionPreference = "Stop"
Write-Host "== Akosua Windows setup ==" -ForegroundColor Cyan

# 1. Prerequisites check (install missing ones from the official sites):
#    - Git for Windows            https://git-scm.com/download/win
#    - Node.js 24.18.0 (EXACT, from vscode/.nvmrc at our pinned commit)  https://nodejs.org
#      TIP: use nvm-windows to pin it:  nvm install 24.18.0 ; nvm use 24.18.0
#    - Python 3.11+               https://www.python.org/downloads/windows/
#    - Visual Studio 2022 Build Tools with "Desktop development with C++" workload
#                                 https://visualstudio.microsoft.com/downloads/
foreach ($cmd in @("git","node","python")) {
  $c = Get-Command $cmd -ErrorAction SilentlyContinue
  if ($c) { Write-Host ("{0}: {1}" -f $cmd, (& $cmd --version 2>$null | Select-Object -First 1)) }
  else { Write-Warning "$cmd NOT FOUND — install it (see comments above), then re-run." }
}
node --version | ForEach-Object { if ($_ -notmatch "v24\.") { Write-Warning "VS Code at our pinned commit expects Node 24.x (.nvmrc=24.18.0). You have $_ — use nvm-windows." } }

# 2. Full clone (the sandbox used a sparse clone; your workstation gets the REAL one)
#    Run this where you want Akosua to live, e.g. C:\dev
# git clone https://github.com/microsoft/vscode akosua
# cd akosua
# git checkout 00ab0906bad641d5be1d009da16baa5cec66a161   # our pinned commit (VS Code 1.143.0)

# 3. Dependencies + first UNMODIFIED run (proves the fork builds before we touch it)
# npm install
# .\scripts\code.bat        # launches Code-OSS dev build

# 4. Rebrand (after the unmodified run works)
# python <path-to>\rebrand_to_akosua.py .
# .\scripts\code.bat        # should now launch as "Akosua"

# 5. Windows installer build (Phase 7, not now)
# npm run gulp -- vscode-win32-x64-user-setup

Write-Host "Setup check done. Follow steps 2-4 in order; paste any error back to the agent." -ForegroundColor Green
