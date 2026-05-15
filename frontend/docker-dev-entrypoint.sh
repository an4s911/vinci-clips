#!/bin/sh
set -eu

lockfile="package-lock.json"
hash_file="node_modules/.package-lock.sha256"

if [ ! -d node_modules ] || [ ! -f "$hash_file" ] || [ "$(sha256sum "$lockfile" | awk '{print $1}')" != "$(cat "$hash_file")" ]; then
  echo "Installing frontend dependencies..."
  npm ci
  sha256sum "$lockfile" | awk '{print $1}' > "$hash_file"
fi

exec npm run dev -- --hostname 0.0.0.0
