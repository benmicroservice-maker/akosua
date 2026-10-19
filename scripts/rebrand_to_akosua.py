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

# --- Akosua clean-field defaults (Cursor-like calm window) ---------------
# Verified against VS Code 1.143.0 sources (pinned 00ab0906): each key is
# registered with these semantics --
#   workbench.startupEditor "none": start without an editor (no Welcome tab)
#   chat.disableAIFeatures: "Disable and hide built-in AI features provided
#     by GitHub Copilot, including chat and inline suggestions"
#   workbench.secondarySideBar.defaultVisibility: Akosua's agent panel is
#     visible on first launch (it is the point of the product)
# User settings still win over product defaults at runtime.
ak_defaults = {
    "workbench.startupEditor": "none",
    "workbench.welcomePage.walkthroughs.openOnInstall": False,
    "chat.disableAIFeatures": True,
    "workbench.secondarySideBar.defaultVisibility": "visible",
    "telemetry.telemetryLevel": "off",
    "workbench.tips.enabled": False,
    "update.mode": "none",
}
merged = dict(d.get("configurationDefaults") or {})
for k, v in ak_defaults.items():
    if merged.get(k) != v:
        print(f"  default {k}: {merged.get(k)!r} -> {v!r}")
        merged[k] = v
d["configurationDefaults"] = merged

p.write_text(json.dumps(d, indent="\t", ensure_ascii=False) + "\n", encoding="utf-8")
# --- UI-1 identity: Akosua icons + installer filename ---------------------
# Icon assets live in <repo>/brand/ next to this script's folder. In CI the
# overlay repo is the cwd's parent of scripts/, same layout as locally.
_brand = pathlib.Path(__file__).resolve().parent.parent / "brand"
_ico = _brand / "akosua.ico"
if _ico.exists():
    import shutil
    win32res = root / "resources" / "win32"
    if win32res.exists():
        shutil.copyfile(_ico, win32res / "code.ico")
        for src_png, dst_png in [("akosua_70x70.png", "code_70x70.png"), ("akosua_150x150.png", "code_150x150.png")]:
            s = _brand / src_png
            if s.exists(): shutil.copyfile(s, win32res / dst_png)
        print("  icons: Akosua code.ico + tiles installed")
    else:
        print("  icons: resources/win32 not found in clone (skipped)")
else:
    print("  icons: brand/akosua.ico not found (skipped)")

_iss = root / "build" / "win32" / "code.iss"
if _iss.exists():
    _t = _iss.read_text(encoding="utf-8", errors="replace")
    if "OutputBaseFilename=VSCodeSetup" in _t:
        _iss.write_text(_t.replace("OutputBaseFilename=VSCodeSetup", "OutputBaseFilename=AkosuaSetup"), encoding="utf-8")
        print("  installer: OutputBaseFilename -> AkosuaSetup")

print("product.json rebranded to Akosua [OK]")
print("NOTE: icons (resources/win32/*.ico, darwin, linux) and win32 GUIDs still need Akosua artwork/GUIDs before release — tracked in PROGRESS_TRACKER.")
