#!/usr/bin/env bash
# Loop POST /api/enrich-pending until remaining=0 (or stalled / ceiling).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LIMIT="${ENRICH_LIMIT:-5}"
URL="${ENRICH_URL:-http://localhost:3210/api/enrich-pending}?limit=${LIMIT}"
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

total_enriched=0
total_failed=0
fails=0
stalled=0
calls=0
max_calls=""

while true; do
  resp="$(curl -s --max-time 900 -w '\n%{http_code}' -X POST "$URL" "${COOKIE_ARGS[@]+"${COOKIE_ARGS[@]}"}" || true)"
  body="$(echo "$resp" | sed '$d')"
  code="$(echo "$resp" | tail -n1)"
  if [ "$code" != "200" ]; then
    fails=$((fails + 1))
    echo "HTTP $code (fail $fails/3)"
    if [ "$fails" -ge 3 ]; then
      echo "Stopping after 3 consecutive failures."
      echo "totals: enriched=$total_enriched failed=$total_failed remaining=?"
      exit 1
    fi
    sleep 2
    continue
  fi
  # node, not python3: the app needs node anyway, and on Windows Git Bash
  # python3 is a Store stub. A parse failure must not read as remaining=0.
  if ! parsed="$(echo "$body" | node -e '
const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
console.log(d.enriched ?? 0, d.failed ?? 0, d.remaining ?? 0);
' 2>/dev/null)"; then
    fails=$((fails + 1))
    echo "unparseable response (fail $fails/3): ${body:0:200}"
    if [ "$fails" -ge 3 ]; then
      echo "Stopping after 3 consecutive failures."
      exit 1
    fi
    sleep 2
    continue
  fi
  fails=0
  calls=$((calls + 1))
  read -r enriched failed remaining <<<"$parsed"
  total_enriched=$((total_enriched + enriched))
  total_failed=$((total_failed + failed))
  echo "enriched=$enriched failed=$failed remaining=$remaining  (running enriched $total_enriched)"

  # Ceiling from remaining at first successful response.
  if [ -z "$max_calls" ]; then
    # ceil(remaining / limit) * 4 + 10; remaining here is post-call, so use
    # remaining + enriched + failed as a stand-in for start size when calls==1.
    start=$((remaining + enriched + failed))
    if [ "$start" -lt 1 ]; then start=1; fi
    batches=$(( (start + LIMIT - 1) / LIMIT ))
    max_calls=$(( batches * 4 + 10 ))
    echo "call ceiling: $max_calls (start≈$start, limit=$LIMIT)"
  fi

  if [ "${remaining:-0}" = "0" ]; then
    echo "done."
    echo "totals: enriched=$total_enriched failed=$total_failed remaining=0"
    exit 0
  fi

  # Stall only when nothing was enriched *and* nothing failed (failures still progress attempts).
  if [ "${enriched:-0}" = "0" ] && [ "${failed:-0}" = "0" ]; then
    stalled=$((stalled + 1))
    if [ "$stalled" -ge 2 ]; then
      echo "Stopping: two consecutive calls made no progress (enriched=0 and failed=0)."
      echo "totals: enriched=$total_enriched failed=$total_failed remaining=$remaining"
      exit 1
    fi
  else
    stalled=0
  fi

  if [ "$calls" -ge "$max_calls" ]; then
    echo "Stopping: call ceiling $max_calls reached."
    echo "totals: enriched=$total_enriched failed=$total_failed remaining=$remaining"
    exit 1
  fi
done
