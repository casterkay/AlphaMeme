#!/bin/sh
# Copies the newest verified backup set from the VPS to this machine and
# re-checks each database's integrity here.
#   scripts/pull-backup.sh <ssh-host-alias> <destination-dir>
# RADAR_BACKUP_DIR overrides the set directory on the VPS (relative to home).
set -eu

host=${1:?usage: scripts/pull-backup.sh <ssh-host-alias> <destination-dir>}
destination=${2:?usage: scripts/pull-backup.sh <ssh-host-alias> <destination-dir>}
remote=${RADAR_BACKUP_DIR:-AlphaMeme/data/backups}

# Only verified sets carry the bare UTC name; a set in progress ends in .partial.
listing=$(ssh "$host" "ls -1 '$remote'")
latest=$(printf '%s\n' "$listing" | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}Z$' | sort | tail -n 1 || true)
if [ -z "$latest" ]; then
  echo "no verified backup set in $host:$remote" >&2
  exit 1
fi
if [ -d "$destination/$latest" ]; then
  echo "$destination/$latest is already here"
  exit 0
fi

mkdir -p "$destination"
rm -rf "$destination/$latest.partial"
scp -rq "$host:$remote/$latest" "$destination/$latest.partial"
for database in "$destination/$latest.partial"/*.sqlite; do
  result=$(sqlite3 -readonly "$database" 'PRAGMA integrity_check')
  if [ "$result" != "ok" ]; then
    echo "$database failed its integrity check after the copy" >&2
    exit 1
  fi
done
mv "$destination/$latest.partial" "$destination/$latest"
echo "$destination/$latest"
