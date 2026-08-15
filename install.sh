#!/bin/zsh

set -euo pipefail

plugin_root="${0:A:h}"
extension_source="$plugin_root/extension"
agent_id="com.eugenesia.antigravity-pdf-preview"
user_id="$(id -u)"
install_dir="$HOME/Library/Application Support/Antigravity/PdfPreviewExtension"
agent_dir="$HOME/Library/LaunchAgents"
agent_file="$agent_dir/$agent_id.plist"
log_dir="$HOME/Library/Logs/Antigravity"

node_bin="$(command -v node || true)"
if [[ -z "$node_bin" ]]; then
  echo "Node.js 22 or later is required. Install it from https://nodejs.org and run this installer again."
  exit 1
fi

node_major="$($node_bin -p 'Number(process.versions.node.split(".")[0])')"
if (( node_major < 22 )); then
  echo "Node.js 22 or later is required; found $($node_bin --version)."
  exit 1
fi

if [[ ! -d "$extension_source" ]]; then
  echo "The extension directory is missing: $extension_source"
  exit 1
fi

mkdir -p "$install_dir" "$agent_dir" "$log_dir"
ditto "$extension_source" "$install_dir"
chmod 755 "$install_dir/pdf-preview-extension.mjs"

plist_tmp="$(mktemp -t antigravity-pdf-preview.XXXXXX)"
trap 'rm -f "$plist_tmp"' EXIT

plutil -create xml1 "$plist_tmp"
plutil -insert Label -string "$agent_id" "$plist_tmp"
plutil -insert ProgramArguments -array "$plist_tmp"
plutil -insert ProgramArguments.0 -string "$node_bin" "$plist_tmp"
plutil -insert ProgramArguments.1 -string "--experimental-websocket" "$plist_tmp"
plutil -insert ProgramArguments.2 -string "$install_dir/pdf-preview-extension.mjs" "$plist_tmp"
plutil -insert RunAtLoad -bool true "$plist_tmp"
plutil -insert KeepAlive -bool true "$plist_tmp"
plutil -insert ProcessType -string Background "$plist_tmp"
plutil -insert StandardOutPath -string "$log_dir/pdf-preview-extension.log" "$plist_tmp"
plutil -insert StandardErrorPath -string "$log_dir/pdf-preview-extension-error.log" "$plist_tmp"
install -m 644 "$plist_tmp" "$agent_file"

launchctl bootout "gui/$user_id/$agent_id" 2>/dev/null || true
if ! launchctl bootstrap "gui/$user_id" "$agent_file" 2>/dev/null; then
  # launchd can need a moment to finish unloading the previous generation.
  sleep 0.5
  launchctl bootstrap "gui/$user_id" "$agent_file"
fi
launchctl enable "gui/$user_id/$agent_id"
launchctl kickstart -k "gui/$user_id/$agent_id"

if [[ ! -d "/Applications/Antigravity.app" ]]; then
  echo "Warning: /Applications/Antigravity.app was not found. The helper is installed but cannot attach yet."
fi

echo "Antigravity PDF Preview is installed."
echo "Fully quit and reopen Antigravity, then open a PDF from its File Viewer."
