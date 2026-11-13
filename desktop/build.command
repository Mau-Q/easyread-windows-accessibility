#!/bin/sh
set -eu
export PATH="/opt/homebrew/bin:$HOME/.cargo/bin:/usr/local/bin:$PATH"
cd "$(dirname "$0")"
npm ci
npm run build
if [ -e ../EasyRead.app ]; then
  bundle_id=$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' ../EasyRead.app/Contents/Info.plist)
  if [ "$bundle_id" != local.rui.easyread ]; then
    echo 'EasyRead.app 已存在且不是本项目应用，停止复制。' >&2
    exit 1
  fi
fi
ditto src-tauri/target/release/bundle/macos/EasyRead.app ../EasyRead.app
codesign --force --deep --sign - ../EasyRead.app
codesign --verify --deep ../EasyRead.app
ditto ../EasyRead.app src-tauri/target/release/bundle/macos/EasyRead.app
echo '已生成 easyread/EasyRead.app'
