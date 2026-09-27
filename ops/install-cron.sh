#!/bin/sh
# Idempotently install the triage cron (stage 2) for the current user.
# Called by trained-assist-agent's scripts/deploy.sh (GCP only) after it syncs this checkout.
# Rewrites only the block between the markers; leaves other crontab entries alone.
set -e
DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
BEGIN="# >>> trained-assist bugs-and-features-pipeline (managed by ops/install-cron.sh) >>>"
END="# <<< trained-assist bugs-and-features-pipeline <<<"
chmod +x "$DIR/ops/triage-cron.sh" 2>/dev/null || true

current=$(crontab -l 2>/dev/null || true)
stripped=$(printf '%s\n' "$current" | awk -v b="$BEGIN" -v e="$END" '
  $0==b {skip=1} skip && $0==e {skip=0; next} skip {next} {print}')
{ printf '%s\n' "$stripped" | sed '/^$/d'; echo "$BEGIN"; echo "*/2 * * * * $DIR/ops/triage-cron.sh"; echo "$END"; } | crontab -
echo "Installed bugs-and-features triage cron: */2 * * * * $DIR/ops/triage-cron.sh"
