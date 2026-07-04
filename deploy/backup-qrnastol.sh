#!/usr/bin/env bash
set -euo pipefail

backup_dir="/var/backups/qrnastol"
source_file="/var/lib/qrnastol/app.json"

mkdir -p "$backup_dir"
if [[ -f "$source_file" ]]; then
  cp "$source_file" "$backup_dir/app-$(date +%Y%m%d-%H%M%S).json"
  find "$backup_dir" -type f -name 'app-*.json' -mtime +30 -delete
fi
