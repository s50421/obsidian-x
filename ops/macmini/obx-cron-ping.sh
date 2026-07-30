#!/bin/bash
# Obsidian-X — cron pinger for the always-on Mac mini.
#
# Why this exists: Vercel's Hobby plan rejects sub-daily crons, and the GitHub
# Actions fallback is throttled hard on the free tier — its observed gaps are
# 1h40m to 3h25m against a requested */15. On 2026-07-30 that gap swallowed the
# morning letter's entire send window and no letter arrived.
#
# An always-on Mac running launchd every 15 minutes does not drift. This becomes
# the PRIMARY trigger; the Vercel daily cron and the GitHub pinger stay on as
# backups. All three endpoints are idempotent (each is gated on a once-per-
# local-date audit marker), so redundant triggers can never double-send.
#
# Install: see ops/macmini/README.md

set -uo pipefail

ENV_FILE="${OBX_ENV_FILE:-$HOME/.obsidian-x/env}"
LOG_FILE="${OBX_LOG_FILE:-$HOME/.obsidian-x/cron.log}"
BASE="${OBX_BASE_URL:-https://obsidian.manhartgroup.com}"

mkdir -p "$(dirname "$LOG_FILE")"

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S%z')" "$*" >>"$LOG_FILE"; }

if [[ ! -f "$ENV_FILE" ]]; then
  log "FATAL no env file at $ENV_FILE — see ops/macmini/README.md"
  exit 0   # exit 0 on purpose: a config error must not make launchd back off
fi

# shellcheck disable=SC1090
source "$ENV_FILE"

if [[ -z "${CRON_SECRET:-}" ]]; then
  log "FATAL CRON_SECRET not set in $ENV_FILE"
  exit 0
fi

# Keep the log from growing without bound (roughly a month of 15-min ticks).
if [[ -f "$LOG_FILE" ]] && [[ $(wc -l <"$LOG_FILE") -gt 20000 ]]; then
  tail -n 5000 "$LOG_FILE" >"$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"
  log "log truncated"
fi

# The endpoints self-gate on the owner's LOCAL time, so hitting them every tick
# is correct and cheap — an out-of-window call returns {"skipped":true} in
# milliseconds without touching the model or the database.
PATHS=(
  /api/cron/brief
  /api/cron/deck-nudge
  /api/cron/gmail-sync
)

for p in "${PATHS[@]}"; do
  body_file=$(mktemp)
  code=$(curl -sS -m 90 -o "$body_file" -w '%{http_code}' \
    -H "Authorization: Bearer $CRON_SECRET" \
    "$BASE$p" 2>>"$LOG_FILE") || code="000"
  body=$(head -c 220 "$body_file" | tr -d '\n')
  rm -f "$body_file"

  if [[ "$code" == "200" ]]; then
    # Only log the interesting ticks; a skip every 15 minutes is just noise.
    if [[ "$body" == *'"skipped":true'* ]]; then
      :
    else
      log "$p -> $code $body"
    fi
  else
    log "$p -> HTTP $code $body"
  fi
done

exit 0
