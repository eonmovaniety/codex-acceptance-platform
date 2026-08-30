#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: restore.sh <absolute-backup-path>" >&2
  exit 2
fi
ROOT=/volume1/docker/forgejo
DATA=/volume2/mydata/forgejo
BACKUP="$1"
DOCKER=/usr/local/bin/docker
case "$BACKUP" in
  "$ROOT"/backups/forgejo-daily-*.tar.gz|"$ROOT"/backups/forgejo-weekly-*.tar.gz) ;;
  *) echo "backup is outside the managed Forgejo backup directory" >&2; exit 2 ;;
esac
[ -f "$BACKUP" ] || { echo "backup not found" >&2; exit 2; }
STAMP="$(date +%Y%m%d-%H%M%S)"
STAGE="$ROOT/restore-$STAMP"
mkdir -p "$STAGE"
tar -xzf "$BACKUP" -C "$STAGE"
[ -f "$STAGE/forgejo/data/forgejo.db" ] || { echo "backup does not contain Forgejo database" >&2; exit 3; }
cd "$ROOT"
sudo -n "$DOCKER" compose stop forgejo
ROLLBACK="/volume2/mydata/forgejo.pre-restore-$STAMP"
mv "$DATA" "$ROLLBACK"
mv "$STAGE/forgejo" "$DATA"
rm -rf "$STAGE"
sudo -n "$DOCKER" compose up -d forgejo
printf 'restored=%s rollback=%s\n' "$BACKUP" "$ROLLBACK"
