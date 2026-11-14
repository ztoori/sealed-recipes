#!/usr/bin/env bash
# Kept so existing links and habits keep working: the setup script is now scripts/setup.sh (Linux, macOS, WSL).
exec bash "$(dirname "${BASH_SOURCE[0]}")/setup.sh" "$@"
