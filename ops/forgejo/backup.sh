#!/bin/sh
set -eu

ROOT=/volume3/docker/forgejo
BACKUPS="$ROOT/backups"
STAMP="$(date +%Y%m%d-%H%M%S)"
ARCHIVE="$BACKUPS/forgejo-daily-$STAMP.tar.gz"
DUMP="$BACKUPS/forgejo-dump-daily-$STAMP.zip"
CONFIG="$BACKUPS/forgejo-config-daily-$STAMP.tar.gz"
TMP="$ARCHIVE.tmp"
CONFIG_TMP="$CONFIG.tmp"
DUMP_IN_DATA="$ROOT/data/data/forgejo-dump-$STAMP.zip"
DOCKER=/usr/local/bin/docker

mkdir -p "$BACKUPS"
restart() {
  cd "$ROOT"
  sudo -n "$DOCKER" compose start forgejo >/dev/null 2>&1 || true
}
trap restart EXIT INT TERM
cd "$ROOT"
sudo -n "$DOCKER" compose stop forgejo
rm -f "$DUMP_IN_DATA"
sudo -n "$DOCKER" compose run --rm --no-deps forgejo forgejo dump \
  --config /var/lib/gitea/custom/conf/app.ini \
  --file "/var/lib/gitea/data/forgejo-dump-$STAMP.zip" \
  --tempdir /tmp \
  --skip-log \
  --quiet
mv "$DUMP_IN_DATA" "$DUMP"
tar -czf "$TMP" -C "$ROOT" data compose.yaml deployment-manifest.json
tar -czf "$CONFIG_TMP" -C "$ROOT" compose.yaml deployment-manifest.json data/custom/conf/app.ini backup.sh restore.sh
mv "$TMP" "$ARCHIVE"
mv "$CONFIG_TMP" "$CONFIG"
chmod 0600 "$ARCHIVE" "$DUMP" "$CONFIG"
restart
trap - EXIT INT TERM

if [ "$(date +%u)" = 7 ]; then
  WEEK="$(date +%G-W%V)"
  cp -n "$ARCHIVE" "$BACKUPS/forgejo-weekly-$WEEK.tar.gz" || true
  cp -n "$DUMP" "$BACKUPS/forgejo-dump-weekly-$WEEK.zip" || true
  cp -n "$CONFIG" "$BACKUPS/forgejo-config-weekly-$WEEK.tar.gz" || true
fi

prune() {
  pattern="$1"
  keep="$2"
  count=0
  for file in $(ls -1t "$BACKUPS"/$pattern 2>/dev/null || true); do
    count=$((count + 1))
    if [ "$count" -gt "$keep" ]; then rm -f "$file"; fi
  done
}
prune 'forgejo-daily-*.tar.gz' 7
prune 'forgejo-dump-daily-*.zip' 7
prune 'forgejo-config-daily-*.tar.gz' 7
prune 'forgejo-weekly-*.tar.gz' 4
prune 'forgejo-dump-weekly-*.zip' 4
prune 'forgejo-config-weekly-*.tar.gz' 4
printf '%s\n' "$ARCHIVE"
