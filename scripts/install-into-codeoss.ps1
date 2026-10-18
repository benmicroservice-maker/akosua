# Installs Akosua (extension + core) into a FULL Code-OSS clone on Windows.
# Usage:  .\install-into-codeoss.ps1 -VsCodePath C:\dev\akosua-vscode
param([Parameter(Mandatory=$true)][string]$VsCodePath)
$ErrorActionPreference = "Stop"
$src = Split-Path -Parent $PSScriptRoot   # ...\akosua  (contains extensions\, akosua-core\)

Write-Host "Copying Akosua extension -> $VsCodePath\extensions\akosua"
Copy-Item -Recurse -Force "$src\extensions\akosua" "$VsCodePath\extensions\akosua"
Write-Host "Copying @akosua/core -> $VsCodePath\akosua-core  (extension depends on file:../../akosua-core)"
Copy-Item -Recurse -Force "$src\akosua-core" "$VsCodePath\akosua-core"
# strip dev artefacts from the copies
foreach ($d in @("$VsCodePath\extensions\akosua\node_modules", "$VsCodePath\extensions\akosua\out",
                 "$VsCodePath\akosua-core\node_modules", "$VsCodePath\akosua-core\dist")) {
  if (Test-Path $d) { Remove-Item -Recurse -Force $d }
}
Write-Host @"
Done. Next (in $VsCodePath):
  npm install            # repo deps (long, first time)
  .\scripts\code.bat     # dev build launches; open the Akosua icon in the Activity Bar
Notes:
 - VS Code's build compiles everything under extensions\ automatically.
 - Extension runtime loads @akosua/core via dynamic import; core is built by the extension's compile step during repo builds (or run: cd akosua-core && npm run build).
"@
