#!/bin/bash
# Patches the Electron binary so the app shows as "MAWS" in dev mode:
#   - Renames the app in Info.plist (dock tooltip, menu bar)
#   - Replaces the bundle icon (About panel, dock)
# Runs automatically after npm install via postinstall.

BUNDLE="node_modules/electron/dist/Electron.app"
PLIST="$BUNDLE/Contents/Info.plist"
ICON_SRC="assets/icon.png"
ICON_DST="$BUNDLE/Contents/Resources/electron.icns"
ICONSET="/tmp/maws-patch.iconset"

if [ ! -f "$PLIST" ]; then
  echo "[patch-electron-name] Electron binary not found, skipping."
  exit 0
fi

# ── Patch name ──────────────────────────────────────────────────────────────
/usr/libexec/PlistBuddy -c "Set :CFBundleName MAWS"        "$PLIST" 2>/dev/null
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName MAWS" "$PLIST" 2>/dev/null
echo "[patch-electron-name] Name patched → MAWS"

# ── Patch icon ───────────────────────────────────────────────────────────────
if [ ! -f "$ICON_SRC" ]; then
  echo "[patch-electron-name] assets/icon.png not found, skipping icon patch."
  exit 0
fi

rm -rf "$ICONSET" && mkdir -p "$ICONSET"
sips -z 16   16   "$ICON_SRC" --out "$ICONSET/icon_16x16.png"        &>/dev/null
sips -z 32   32   "$ICON_SRC" --out "$ICONSET/icon_16x16@2x.png"     &>/dev/null
sips -z 32   32   "$ICON_SRC" --out "$ICONSET/icon_32x32.png"        &>/dev/null
sips -z 64   64   "$ICON_SRC" --out "$ICONSET/icon_32x32@2x.png"     &>/dev/null
sips -z 128  128  "$ICON_SRC" --out "$ICONSET/icon_128x128.png"      &>/dev/null
sips -z 256  256  "$ICON_SRC" --out "$ICONSET/icon_128x128@2x.png"   &>/dev/null
sips -z 256  256  "$ICON_SRC" --out "$ICONSET/icon_256x256.png"      &>/dev/null
sips -z 512  512  "$ICON_SRC" --out "$ICONSET/icon_256x256@2x.png"   &>/dev/null
sips -z 512  512  "$ICON_SRC" --out "$ICONSET/icon_512x512.png"      &>/dev/null
cp "$ICON_SRC"                      "$ICONSET/icon_512x512@2x.png"

iconutil -c icns "$ICONSET" -o "$ICON_DST" 2>/dev/null
rm -rf "$ICONSET"

# Also generate assets/icon.icns for electron-builder
iconutil -c icns "$ICONSET" -o assets/icon.icns 2>/dev/null || true
mkdir -p "$ICONSET" 2>/dev/null
sips -z 16   16   "$ICON_SRC" --out "$ICONSET/icon_16x16.png"        &>/dev/null
sips -z 32   32   "$ICON_SRC" --out "$ICONSET/icon_16x16@2x.png"     &>/dev/null
sips -z 32   32   "$ICON_SRC" --out "$ICONSET/icon_32x32.png"        &>/dev/null
sips -z 64   64   "$ICON_SRC" --out "$ICONSET/icon_32x32@2x.png"     &>/dev/null
sips -z 128  128  "$ICON_SRC" --out "$ICONSET/icon_128x128.png"      &>/dev/null
sips -z 256  256  "$ICON_SRC" --out "$ICONSET/icon_128x128@2x.png"   &>/dev/null
sips -z 256  256  "$ICON_SRC" --out "$ICONSET/icon_256x256.png"      &>/dev/null
sips -z 512  512  "$ICON_SRC" --out "$ICONSET/icon_256x256@2x.png"   &>/dev/null
sips -z 512  512  "$ICON_SRC" --out "$ICONSET/icon_512x512.png"      &>/dev/null
cp "$ICON_SRC"                      "$ICONSET/icon_512x512@2x.png"
iconutil -c icns "$ICONSET" -o assets/icon.icns &>/dev/null
rm -rf "$ICONSET"

echo "[patch-electron-name] Icon patched → assets/icon.icns + Electron bundle"
