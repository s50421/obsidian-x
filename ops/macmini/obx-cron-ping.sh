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
# SECRET HANDLING: CRON_SECRET is read from the macOS Keychain, never from a
# file on disk and never from the process arguments (which are world-readable
# via `ps`). This matters more than it first appears — CRON_SECRET is not just a
# trigger, it is effectively a READ credential: /api/cron/brief?preview=1
# returns the rendered letter, including email senders and subjects.
#
# Install: see ops/macmini/README.md

set -uo pipefail

KEYCHAIN_SERVICE="${OBX_KEYCHAIN_SERVICE:-obsidian-x-cron}"
LOG_FILE="${OBX_LOG_FILE:-$HOME/.obsidian-x/cron.log}"
BASE="${OBX_BASE_URL:-https://obsidian.manhartgroup.com}"

mkdir -p "$(dirname "$LOG_FILE")"
chmod 700 "$(dirname "$LOG_FILE")" 2>/dev/null || true

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S%z')" "$*" >>"$LOG_FILE"; }

# Read the secret from the login keychain. Requires an unlocked keychain, which
# is the case in a normal logged-in session. Falls back to OBX_CRON_SECRET only
# for local testing — never set that in the LaunchAgent.
CRON_SECRET="${OBX_CRON_SECRET:-}"
if [[ -z "$CRON_SECRET" ]]; then
  CRON_SECRET=$(security find-generic-password -s "$KEYCHAIN_SERVICE" -w 2>/dev/null) || CRON_SECRET=""
fi

if [[ -z "$CRON_SECRET" ]]; then
  log "FATAL no secret in keychain service '$KEYCHAIN_SERVICE' — see ops/macmini/README.md"
  exit 0 # exit 0 on purpose: a config error must not make launchd back the job off
fi

# Keep the log bounded (roughly a month of 15-min ticks).
if [[ -f "$LOG_FILE" ]] && [[ $(wc -l <"$LOG_FILE") -gt 20000 ]]; then
  tail -n 5000 "$LOG_FILE" >"$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"
  chmod 600 "$LOG_FILE"
  log "log truncated"
fi
touch "$LOG_FILE" && chmod 600 "$LOG_FILE"

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
  # The token goes in a header, never the URL: query strings land in access
  # logs, proxy logs and Referer headers. `--no-progress-meter` keeps stderr
  # clean so real errors stand out in the launchd log.
  code=$(curl -sS --no-progress-meter -m 90 -o "$body_file" -w '%{http_code}' \
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

unset CRON_SECRET
exit 0
