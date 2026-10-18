# Akosua — one-script Windows build (Phase 1 + 7 handover)
# Run on the user's Windows workstation in PowerShell (normal user; installers may prompt admin):
#   .\build-on-windows.ps1                      # full guided sequence, prompts between stages
#   .\build-on-windows.ps1 -FromStage 3         # resume from a stage (state is saved per stage)
#   .\build-on-windows.ps1 -Installer           # also build the Windows user-setup installer at the end
#   .\build-on-windows.ps1 -Force               # no interactive pauses (still stops on errors)
#
# Stages: 0 prerequisites · 1 clone+pinned checkout · 2 deps + UNMODIFIED baseline launch
#         3 rebrand to Akosua · 4 install Akosua extension+core · 5 build core + launch Akosua
#         6 (optional, -Installer) Windows installer
# Every stage is recorded in <WorkDir>\akosua-build-state.json and log in akosua-build-log.txt.
# Nothing in this script downloads anything except the public microsoft/vscode repo + npm deps.

param(
  [string]$WorkDir = "C:\dev\akosua-build",
  [int]$FromStage = 0,
  [switch]$Installer,
  [switch]$Force
)
$ErrorActionPreference = "Stop"
$PinnedCommit = "00ab0906bad641d5be1d009da16baa5cec66a161"   # VS Code 1.143.0 (pinned, see PROGRESS_TRACKER)
$VsCode = Join-Path $WorkDir "vscode"
$AkosuaSrc = Split-Path -Parent $PSScriptRoot                    # ...\akosua (extensions\, akosua-core\, scripts\)
$StateFile = Join-Path $WorkDir "akosua-build-state.json"
$LogFile = Join-Path $WorkDir "akosua-build-log.txt"

function Log([string]$Msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Msg
  Write-Host $line -ForegroundColor Cyan
  Add-Content -Path $LogFile -Value $line
}
function Gate([string]$Msg) {
  if ($Force) { return }
  Write-Host ""
  Write-Host $Msg -ForegroundColor Yellow
  Read-Host "Press ENTER when done (or fix issues, then ENTER to retry this stage's check)"
}
function Stage-Done([int]$N, [string]$Name) {
  $state = @{}
  if (Test-Path $StateFile) { (Get-Content $StateFile -Raw | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $state[$_.Name] = $_.Value } }
  $state["stage$N"] = "{0} @ {1}" -f $Name, (Get-Date -Format s)
  $state | ConvertTo-Json | Set-Content $StateFile
  Log "Stage $N ($Name) complete."
}
function Should-Run([int]$N) {
  if ($N -lt $FromStage) { return $false }
  if (-not (Test-Path $StateFile)) { return $true }
  $state = Get-Content $StateFile -Raw | ConvertFrom-Json
  return $null -eq $state."stage$N"
}

New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
Log "Akosua Windows build starting. WorkDir=$WorkDir Pinned=$PinnedCommit"

try {
  # ---------- Stage 0: prerequisites ----------
  if (Should-Run 0) {
    Log "Stage 0: checking prerequisites (Git, Node 24.x, Python 3.11+, VS 2022 Build Tools)..."
    foreach ($cmd in @("git", "node", "python")) {
      $c = Get-Command $cmd -ErrorAction SilentlyContinue
      if (-not $c) { throw "$cmd NOT FOUND. Install it (see setup-windows.ps1 comments) and re-run with -FromStage 0." }
      Log ("  {0}: {1}" -f $cmd, (& $cmd --version 2>$null | Select-Object -First 1))
    }
    $nv = node --version
    if ($nv -notmatch "^v24\.") { throw "Node must be 24.x (pinned .nvmrc = 24.18.0); found $nv. Use nvm-windows: nvm install 24.18.0; nvm use 24.18.0" }
    $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
    if (Test-Path $vswhere) {
      $vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property displayName 2>$null
      if (-not $vs) { Write-Warning "Visual Studio C++ tools not detected via vswhere. VS Code's native deps need 'Desktop development with C++'. npm install will fail without it." }
      else { Log "  VS C++ tools: $vs" }
    } else { Write-Warning "vswhere not found — if npm install fails on node-gyp, install VS 2022 Build Tools with the C++ workload." }
    Stage-Done 0 "prerequisites"
  }

  # ---------- Stage 1: clone + pin ----------
  if (Should-Run 1) {
    if (-not (Test-Path (Join-Path $VsCode ".git"))) {
      Log "Stage 1: cloning microsoft/vscode (full clone, several GB, one time)..."
      git clone https://github.com/microsoft/vscode $VsCode
    } else { Log "Stage 1: existing clone found, reusing." }
    Push-Location $VsCode
    git checkout $PinnedCommit
    $actual = git rev-parse HEAD
    if ($actual -ne $PinnedCommit) { throw "Checkout mismatch: $actual != $PinnedCommit" }
    Pop-Location
    Log "  pinned at $actual (VS Code 1.143.0)"
    Stage-Done 1 "clone+pinned"
  }

  # ---------- Stage 2: deps + unmodified baseline ----------
  if (Should-Run 2) {
    Log "Stage 2: npm install in the UNMODIFIED clone (long on first run — this is normal)..."
    Push-Location $VsCode
    npm install
    Pop-Location
    Gate "About to launch the UNMODIFIED Code-OSS dev build (.\scripts\code.bat).`nCHECK: a vanilla VS Code window (Code - OSS) opens with NO Akosua branding. Close it when verified."
    Push-Location $VsCode
    & .\scripts\code.bat
    Pop-Location
    Gate "Baseline check: did the vanilla window open and work (open a folder, type in a file)? If it crashed, paste the error back to the agent BEFORE continuing."
    Stage-Done 2 "baseline-unmodified"
  }

  # ---------- Stage 3: rebrand ----------
  if (Should-Run 3) {
    Log "Stage 3: rebranding product.json to Akosua..."
    python (Join-Path $PSScriptRoot "rebrand_to_akosua.py") $VsCode
    Stage-Done 3 "rebrand"
  }

  # ---------- Stage 4: install Akosua into the fork ----------
  if (Should-Run 4) {
    Log "Stage 4: installing Akosua extension + @akosua/core into the fork..."
    & (Join-Path $PSScriptRoot "install-into-codeoss.ps1") -VsCodePath $VsCode
    Stage-Done 4 "install-akosua"
  }

  # ---------- Stage 5: build core + launch Akosua ----------
  if (Should-Run 5) {
    Log "Stage 5a: building @akosua/core inside the fork..."
    Push-Location (Join-Path $VsCode "akosua-core")
    npm install
    npm run build
    Pop-Location
    Log "Stage 5b: npm install at repo root (picks up the new built-in extension)..."
    Push-Location $VsCode
    npm install
    Pop-Location
    Gate "About to launch Akosua (.\scripts\code.bat).`nCHECK: window is branded Akosua, and the Activity Bar has the Akosua icon. Open it: Providers & Keys tab + Chat tab should render. Close the window when verified."
    Push-Location $VsCode
    & .\scripts\code.bat
    Pop-Location
    Gate "Akosua launch check: sidebar renders? Then follow WINDOWS_HANDOVER.md section 3 (keys + models + first agent run on the sample monorepo)."
    Stage-Done 5 "build+launch-akosua"
  }

  # ---------- Stage 6 (optional): Windows installer ----------
  if ($Installer) {
    if (Should-Run 6) {
      Log "Stage 6: building Windows user-setup installer (long)..."
      Push-Location $VsCode
      npm run gulp -- vscode-win32-x64-user-setup
      Pop-Location
      Log "Installer output: look under $VsCode\.build\win32-x64\user-setup\ for VSCodeUserSetup / Akosua setup .exe"
      Stage-Done 6 "installer"
    }
  }

  Log "ALL REQUESTED STAGES COMPLETE. Next: WINDOWS_HANDOVER.md sections 3-4 (keys, model ids, dogfooding checklist)."
} catch {
  Write-Host ""
  Write-Host "FAILED: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "Log: $LogFile  ·  State: $StateFile" -ForegroundColor Red
  Write-Host "Fix the cause, then resume with: .\build-on-windows.ps1 -FromStage <failed stage>" -ForegroundColor Yellow
  exit 1
}
