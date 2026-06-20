#!/bin/bash
set -e

ELECTRON_VERSION="30.5.1"
DIST_DIR="node_modules/electron/dist"
ARCH=$(uname -m)

if [ "$ARCH" = "arm64" ]; then
  PLATFORM="darwin-arm64"
else
  PLATFORM="darwin-x64"
fi

ZIP="electron-v${ELECTRON_VERSION}-${PLATFORM}.zip"
URL="https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}/${ZIP}"
TMP="/tmp/${ZIP}"

echo "🔧 Maws: fixing Electron ${ELECTRON_VERSION} for ${PLATFORM}"
echo "⬇️  Downloading binary from GitHub..."

curl -L --progress-bar -o "$TMP" "$URL"

echo "📦 Extracting..."
rm -rf "${DIST_DIR}/Electron.app"
unzip -q -o "$TMP" -d "$DIST_DIR"

echo "📝 Writing path.txt..."
echo -n "Electron.app/Contents/MacOS/Electron" > node_modules/electron/path.txt

echo "✅ Fixed! Run: npm start"
