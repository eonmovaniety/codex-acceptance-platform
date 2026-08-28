#!/bin/sh
set -eu

ROOT=/volume3/docker/forgejo
BACKUPS="$ROOT/backups"
STAMP="$(date +%Y%m%d-%H%M%S)"
ARCHIVE="$BACKUPS/forgejo-$STAMP.tar.gz"
TMP="$ARCHIVE.tmp"
DOCKER=/usr/local/bin/docker

mkdir -p "$BACKUPS"
restart() {
  cd "$ROOT"
  sudo -n "$DOCKER" compose start forgejo >/dev/null 2>&1 || true
}
trap restart EXIT INT TERM
cd "$ROOT"
sudo -n "$DOCKER" compose stop forgejo
tar -czf "$TMP" -C "$ROOT" data compose.yaml deployment-manifest.json
mv "$TMP" "$ARCHIVE"
restart
trap - EXIT INT TERM

find "$BACKUPS" -maxdepth 1 -type f -name 'forgejo-*.tar.gz' -mtime +28 -delete
printf '%s\n' "$ARCHIVE"
