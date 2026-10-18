# Akosua — CI build on a GitHub Windows runner.
# Clones microsoft/vscode (SHALLOW, pinned commit), rebrands, installs the
# Akosua extension+core from THIS repo, builds the Windows user-setup installer.
# Called by .github/workflows/build-akosua-windows.yml. Also runnable locally
# in PowerShell for debugging:  .\ci-build-windows.ps1 -KeepVsCode
param(
  [string]$VsCodeDir = "",
  [string]$OverlayDir = "",
  [switch]$KeepVsCode,
  [switch]$SkipInstaller  # compile only (faster smoke test of the whole chain)
)
$ErrorActionPreference = "Stop"
$PinnedCommit = "00ab0906bad641d5be1d009da16baa5cec66a161"   # VS Code 1.143.0
if (-not $OverlayDir) { $OverlayDir = Split-Path -Parent $PSScriptRoot }   # repo root (akosua/)
if (-not $VsCodeDir)  { $VsCodeDir = Join-Path (Split-Path -Parent $OverlayDir) "vscode-src" }
if ($env:GITHUB_WORKSPACE -and -not $PSBoundParameters.ContainsKey("VsCodeDir")) {
  $VsCodeDir = Join-Path $env:GITHUB_WORKSPACE "vscode-src"
}

function Step([string]$Msg) { Write-Host ""; Write-Host "== $Msg ==" -ForegroundColor Cyan }
function Disk([string]$Where) {
  $d = Get-PSDrive -Name ([System.IO.Path]::GetPathRoot($VsCodeDir).Substring(0,1))
  Write-Host ("Disk at {0}: {1:N1} GB free" -f $Where, ($d.Free / 1GB)) -ForegroundColor DarkGray
}

Step "Akosua CI build"
Write-Host "Overlay : $OverlayDir"
Write-Host "VS Code : $VsCodeDir @ $PinnedCommit"
Write-Host "Node    : $(node --version)  Python: $(python --version 2>&1)  Git: $(git --version)"
Disk "start"

# 1. Shallow clone at the pinned commit (full history would waste GBs + minutes)
if (-not (Test-Path (Join-Path $VsCodeDir ".git"))) {
  Step "Cloning microsoft/vscode (depth 1, pinned commit)"
  New-Item -ItemType Directory -Force -Path $VsCodeDir | Out-Null
  Push-Location $VsCodeDir
  git init -q
  git remote add origin https://github.com/microsoft/vscode.git
  git fetch -q --depth 1 origin $PinnedCommit
  git checkout -q FETCH_HEAD
  Pop-Location
} else { Write-Host "Reusing existing vscode clone." }
Push-Location $VsCodeDir; $actual = git rev-parse HEAD; Pop-Location
if ($actual -ne $PinnedCommit) { throw "Pinned checkout mismatch: $actual" }
Disk "after clone"

# 2. Rebrand + install Akosua overlay
Step "Rebranding to Akosua"
python (Join-Path $OverlayDir "scripts\rebrand_to_akosua.py") $VsCodeDir
Step "Installing Akosua extension + core into the fork"
& (Join-Path $OverlayDir "scripts\install-into-codeoss.ps1") -VsCodePath $VsCodeDir

# 3. Build @akosua/core (the extension loads it at runtime)
Step "Building @akosua/core"
Push-Location (Join-Path $VsCodeDir "akosua-core")
npm install --no-audit --no-fund
npm run build
Pop-Location

# 4. VS Code dependencies (the long one)
Step "npm install (VS Code, first run is long)"
Push-Location $VsCodeDir
$env:GYP_MSVS_VERSION = "2022"     # runner image ships VS 2022; pin gyp to it
npm install --no-audit --no-fund
Pop-Location
Disk "after npm install"

# 5. Compile + package the Windows user-setup installer
if ($SkipInstaller) { Step "SkipInstaller set — stopping after dependency install (smoke test mode)" }
else {
  Step "Building Windows installer (gulp vscode-win32-x64-user-setup)"
  Push-Location $VsCodeDir
  npm run gulp -- vscode-win32-x64-user-setup
  Pop-Location
  $setupDir = Join-Path $VsCodeDir ".build\win32-x64\user-setup"
  $exe = Get-ChildItem -Path $setupDir -Filter "*.exe" -ErrorAction SilentlyContinue | Select-Object -First 5
  if (-not $exe) { throw "Installer build finished but no .exe found under $setupDir" }
  Step "Installer produced"
  $exe | ForEach-Object { Write-Host ("  {0}  ({1:N0} MB)" -f $_.FullName, ($_.Length / 1MB)) }
  if ($env:GITHUB_OUTPUT) { "setup_dir=$setupDir" | Out-File -FilePath $env:GITHUB_OUTPUT -Append }
}
Disk "end"
Write-Host "CI BUILD OK" -ForegroundColor Green
