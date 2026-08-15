#!/bin/zsh

set -euo pipefail

agent_id="com.eugenesia.antigravity-pdf-preview"
user_id="$(id -u)"
agent_file="$HOME/Library/LaunchAgents/$agent_id.plist"
install_dir="$HOME/Library/Application Support/Antigravity/PdfPreviewExtension"

launchctl bootout "gui/$user_id/$agent_id" 2>/dev/null || true
rm -f "$agent_file"
rm -rf "$install_dir"

echo "Antigravity PDF Preview has been removed."
