# Akosua — push this folder to your GitHub repo, then trigger the build.
# Needs ONLY Git for Windows (https://git-scm.com/download/win) — no Node, no VS, nothing else.
# Run in PowerShell from this folder:  .\PUSH-ME.ps1
$ErrorActionPreference = "Stop"
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw "Git not found. Install Git for Windows first: https://git-scm.com/download/win" }
Write-Host "Pushing Akosua to https://github.com/benmicroservice-maker/akosua.git ..." -ForegroundColor Cyan
Write-Host "A browser/Git login window may open — sign in as benmicroservice-maker." -ForegroundColor Yellow
git push -u origin main
Write-Host ""
Write-Host "PUSH OK. Now trigger the build:" -ForegroundColor Green
Write-Host "  1. Open https://github.com/benmicroservice-maker/akosua/actions"
Write-Host "  2. Pick 'Build Akosua for Windows' -> Run workflow"
Write-Host "  3. FIRST run: tick 'smoke_only' (proves the chain cheaply). Then run again WITHOUT it for the installer."
Write-Host "  4. Download 'Akosua-Windows-Installer' from the finished run."
