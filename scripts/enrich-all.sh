#!/usr/bin/env bash
# Loop POST /api/enrich-pending until enriched=0.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
URL="${ENRICH_URL:-http://localhost:3210/api/enrich-pending}"
COOKIE_ARGS=()

# Passcode gate: cookie value is the literal "ok" (see src/middleware.ts).
if [ -f "$ROOT/.env.local" ]; then
  # shellcheck disable=SC1091
  set -a
  # Read APP_PASSCODE without printing it.
  APP_PASSCODE="$(
    awk -F= '/^APP_PASSCODE=/{sub(/^APP_PASSCODE=/,""); gsub(/^["'\'']|["'\'']$/,""); print; exit}' \
      "$ROOT/.env.local" || true
  )"
  set +a
fi

if [ -n "${APP_PASSCODE:-}" ]; then
  COOKIE_ARGS=(-H "Cookie: rv_auth=ok")
  echo "APP_PASSCODE set — sending rv_auth=ok cookie"
fi

total=0
fails=0
while true; do
  resp="$(curl -s -w '\n%{http_code}' -X POST "$URL" "${COOKIE_ARGS[@]+"${COOKIE_ARGS[@]}"}" || true)"
  body="$(echo "$resp" | sed '$d')"
  code="$(echo "$resp" | tail -n1)"
  if [ "$code" != "200" ]; then
    fails=$((fails + 1))
    echo "HTTP $code (fail $fails/3)"
    if [ "$fails" -ge 3 ]; then
      echo "Stopping after 3 consecutive failures."
      echo "If the app uses APP_PASSCODE, ensure you are logged in or Cookie rv_auth=ok is accepted."
      exit 1
    fi
    sleep 2
    continue
  fi
  fails=0
  enriched="$(echo "$body" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("enriched",0))' 2>/dev/null || echo 0)"
  total=$((total + enriched))
  echo "enriched +$enriched  (running total $total)"
  if [ "$enriched" = "0" ]; then
    echo "done."
    exit 0
  fi
done
