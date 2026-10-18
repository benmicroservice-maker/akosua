#!/usr/bin/env python3
"""
Akosua rebrand script — run against a FULL clone of microsoft/vscode (Code-OSS).
Usage (on the Windows workstation, from the vscode clone root):
    python scripts/rebrand_to_akosua.py .
It patches product.json branding to Akosua. Idempotent. GUIDs (win32x64AppId etc.)
are intentionally left untouched for dev builds — generate fresh GUIDs before
shipping any installer (see PROGRESS_TRACKER Phase 7).
"""
import json, sys, pathlib

root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")
p = root / "product.json"
d = json.loads(p.read_text(encoding="utf-8"))

changes = {
    "nameShort": "Akosua",
    "nameLong": "Akosua",
    "applicationName": "akosua",
    "dataFolderName": ".akosua",
    "sharedDataFolderName": ".akosua-shared",
    "win32MutexName": "akosua",
    "serverApplicationName": "akosua-server",
    "serverDataFolderName": ".akosua-server",
    "tunnelApplicationName": "akosua-tunnel",
    "win32DirName": "Akosua",
    "win32NameVersion": "Akosua",
    "win32RegValueName": "Akosua",
    "win32AppUserModelId": "Akosua.Akosua",
    "win32ShellNameShort": "Akosua",
    "win32TunnelServiceMutex": "akosua-tunnel-service",
    "win32TunnelMutex": "akosua-tunnel",
    "darwinBundleIdentifier": "dev.akosua.app",
    "linuxDesktopName": "akosua.desktop",
    "linuxIconName": "akosua",
    "urlProtocol": "akosua",
    "reportIssueUrl": "https://github.com/microsoft/vscode/issues/new",  # placeholder until Akosua repo exists
}
for k, v in changes.items():
    if d.get(k) != v:
        print(f"  {k}: {d.get(k)!r} -> {v!r}")
        d[k] = v

# Code-OSS default gallery is Open VSX already; make it explicit if the key exists.
if "extensionsGallery" in d:
    d["extensionsGallery"] = {
        "serviceUrl": "https://open-vsx.org/vscode/gallery",
        "itemUrl": "https://open-vsx.org/vscode/item",
        "resourceUrlTemplate": "https://open-vsx.org/vscode/gallery/{publisher}/{name}/{version}/latest",
        "controlUrl": "",
        " recommendationsUrl": "",
    }

p.write_text(json.dumps(d, indent="\t", ensure_ascii=False) + "\n", encoding="utf-8")
print("product.json rebranded to Akosua [OK]")
print("NOTE: icons (resources/win32/*.ico, darwin, linux) and win32 GUIDs still need Akosua artwork/GUIDs before release — tracked in PROGRESS_TRACKER.")
