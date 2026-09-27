#!/usr/bin/env bash
# Cron wrapper — one triage pass (stage 2) over every user's bugs-and-features reports.
# Installed by ops/install-cron.sh:  */2 * * * *  <checkout>/ops/triage-cron.sh
#
# Quiet by default: a pass with nothing pending leaves no log. flock keeps passes from
# overlapping (one agent run can take minutes).
set -euo pipefail

DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
LOG_DIR="${BF_LOG_DIR:-$HOME/agent-data/bugs-and-features-pipeline/logs}"
mkdir -p "$LOG_DIR"
ls -t "$LOG_DIR"/run-*.log 2>/dev/null | tail -n +201 | xargs -r rm -- || true

# GITHUB_ISSUES_TOKEN (+ USERS_DIR if set) come from the agent's secrets.env.
if [ -f "$HOME/secrets.env" ]; then set -a; . "$HOME/secrets.env"; set +a; fi
if [ -z "${LLM_LADDER_TOKEN:-}" ] && [ -f "$HOME/agent-tokens/llm-ladder/token" ]; then
  LLM_LADDER_TOKEN=$(tr -d '[:space:]' < "$HOME/agent-tokens/llm-ladder/token"); export LLM_LADDER_TOKEN
fi
export USERS_DIR="${USERS_DIR:-$HOME/users}"

exec 9>"$LOG_DIR/.lock"
flock -n 9 || exit 0

cd "$DIR"
if ! OUT="$(node src/triage.js 2>&1)"; then
  { echo "[cron] triage FAILED $(date -u)"; printf '%s\n' "$OUT"; } > "$LOG_DIR/run-$(date +%Y%m%d-%H%M%S).log"
  exit 0
fi
if ! printf '%s' "$OUT" | grep -q 'no reports pending'; then
  { echo "[cron] $(date -u)"; printf '%s\n' "$OUT"; } > "$LOG_DIR/run-$(date +%Y%m%d-%H%M%S).log"
fi
