#!/usr/bin/env bash
# Loop POST /api/enrich-pending until remaining=0 (or stalled).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
URL="${ENRICH_URL:-http://localhost:3210/api/enrich-pending}?limit=5"
COOKIE_ARGS=()

APP_PASSCODE=""
if [ -f "$ROOT/.env.local" ]; then
  APP_PASSCODE="$(
    awk -F= '/^APP_PASSCODE=/{sub(/^APP_PASSCODE=/,""); gsub(/^["'\'']|["'\'']$/,""); print; exit}' \
      "$ROOT/.env.local" || true
  )"
fi

if [ -n "${APP_PASSCODE:-}" ]; then
  # Same HMAC as src/lib/passcode.ts — never print the passcode or digest source.
  AUTH="$(printf '%s' 'rv_auth:v1' | openssl dgst -sha256 -hmac "$APP_PASSCODE" | awk '{print $NF}')"
  COOKIE_ARGS=(-H "Cookie: rv_auth=${AUTH}")
  echo "APP_PASSCODE set — sending HMAC rv_auth cookie"
fi

total=0
fails=0
stalled=0
while true; do
  resp="$(curl -s --max-time 900 -w '\n%{http_code}' -X POST "$URL" "${COOKIE_ARGS[@]+"${COOKIE_ARGS[@]}"}" || true)"
  body="$(echo "$resp" | sed '$d')"
  code="$(echo "$resp" | tail -n1)"
  if [ "$code" != "200" ]; then
    fails=$((fails + 1))
    echo "HTTP $code (fail $fails/3)"
    if [ "$fails" -ge 3 ]; then
      echo "Stopping after 3 consecutive failures."
      exit 1
    fi
    sleep 2
    continue
  fi
  fails=0
  read -r enriched failed remaining <<<"$(echo "$body" | python3 -c '
import sys, json
d=json.load(sys.stdin)
print(d.get("enriched",0), d.get("failed",0), d.get("remaining",0))
' 2>/dev/null || echo "0 0 0")"
  total=$((total + enriched))
  echo "enriched=$enriched failed=$failed remaining=$remaining  (running total $total)"
  if [ "${remaining:-0}" = "0" ]; then
    echo "done."
    exit 0
  fi
  if [ "${enriched:-0}" = "0" ]; then
    stalled=$((stalled + 1))
    if [ "$stalled" -ge 2 ]; then
      echo "Stopping: two consecutive calls made no progress."
      exit 1
    fi
  else
    stalled=0
  fi
done
