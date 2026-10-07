#!/usr/bin/env bash
# Pull-based deploy for staging: a systemd timer (installed by install-staging.sh) runs this as root every
# 2 minutes. When the branch on GitHub has a new commit, it rebuilds with the existing deploy/staging.env.
# Nothing on GitHub runs code on this server and no inbound SSH is needed — the VPS only fetches the public repo.
# Logs: journalctl -u kantor-auto-update -n 100
set -euo pipefail
DIR="${DIR:-/opt/kantor}"
STATE=/var/lib/kantor; mkdir -p "$STATE"
exec 9>/var/lock/kantor-deploy.lock
flock -n 9 || exit 0   # a deploy is already running

BRANCH=$(git -C "$DIR" rev-parse --abbrev-ref HEAD)
git -C "$DIR" fetch -q origin "$BRANCH"
remote=$(git -C "$DIR" rev-parse "origin/$BRANCH")
[ "$remote" = "$(cat "$STATE/deployed" 2>/dev/null || true)" ] && exit 0

# A revision that failed is retried at most every 30 minutes instead of rebuilding on every tick.
if [ "$remote" = "$(cat "$STATE/failed" 2>/dev/null || true)" ] && [ -z "$(find "$STATE/failed" -mmin +30 2>/dev/null)" ]; then exit 0; fi

echo "Revisi baru ${remote:0:7} — deploy dimulai"
git -C "$DIR" checkout -q "$BRANCH" && git -C "$DIR" reset -q --hard "$remote"
export BRANCH DIR NO_LOCK=1 AUTO_UPDATE_RUN=1   # read by install-staging.sh
if bash "$DIR/deploy/install-staging.sh" </dev/null; then
  rm -f "$STATE/failed"; echo "Deploy ${remote:0:7} selesai"
else
  echo "$remote" > "$STATE/failed"; echo "Deploy ${remote:0:7} GAGAL (dicoba lagi dalam 30 menit)"; exit 1
fi
