#!/bin/bash
# Double-click to backfill reel content into the vault.
#
# Does the whole chain in order: installs what's missing, starts the Instagram
# helper, checks the account is still linked, then extracts.
#
# Safe to stop with Ctrl+C and re-run — extraction resumes where it left off.
# It never enters your Instagram password: it uses the session you already
# linked. If that session has expired it stops and asks you to re-link.

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
BRIDGE="$ROOT/ig-bridge"
VENV="$BRIDGE/.venv"

# How many items to process this run. Passed as the first argument, so
# `run-extraction.command 50` does fifty. Default is a small proving batch —
# better to discover a problem in five minutes than three hours.
LIMIT="${1:-10}"

echo "───────────────────────────────────────────────"
echo " Reel Vault — content extraction"
echo "───────────────────────────────────────────────"
echo ""

# ---------- 1. environment ----------
if [ ! -d "$VENV" ]; then
  echo "First run: creating the Python environment (one time)…"
  python3 -m venv "$VENV" || { echo "Could not create venv."; read -r -p "Press Return to close."; exit 1; }
fi
source "$VENV/bin/activate"

echo "Checking dependencies…"
python -m pip install --quiet --upgrade pip
python -m pip install --quiet -r "$BRIDGE/requirements.txt"
python -m pip install --quiet -r "$ROOT/pipeline/requirements.txt"
echo "  dependencies ok"

# ffmpeg is only needed for transcripts and on-screen text. Without it the run
# still does something worth doing — captions alone turn "Shared by 7456093337"
# into a real title and searchable text — so degrade instead of refusing.
EXTRA_ARGS=""
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo ""
  echo "  NOTE: ffmpeg not found, so this run does captions only."
  echo "        For transcripts and on-screen text:  brew install ffmpeg"
  echo "        then re-run this script — it will fill them in."
  EXTRA_ARGS="--captions-only"
fi

# ---------- 2. Instagram helper ----------
echo ""
if curl -s -m 3 http://127.0.0.1:8765/health >/dev/null 2>&1; then
  echo "Instagram helper already running."
else
  echo "Starting the Instagram helper…"
  ( cd "$BRIDGE" && nohup "$VENV/bin/uvicorn" main:app --host 127.0.0.1 --port 8765 \
      > "$BRIDGE/bridge.log" 2>&1 & )
  for _ in $(seq 1 30); do
    sleep 1
    curl -s -m 3 http://127.0.0.1:8765/health >/dev/null 2>&1 && break
  done
  if ! curl -s -m 3 http://127.0.0.1:8765/health >/dev/null 2>&1; then
    echo "  Helper did not start. See $BRIDGE/bridge.log"
    read -r -p "Press Return to close."
    exit 1
  fi
  echo "  helper up on 127.0.0.1:8765"
fi

# ---------- 3. is the account still linked? ----------
HEALTH="$(curl -s -m 10 http://127.0.0.1:8765/health)"
if ! echo "$HEALTH" | grep -q '"logged_in": *true'; then
  echo ""
  echo "  The saved Instagram session is no longer valid."
  echo ""
  echo "  Re-link it yourself (this script will not ask for your password):"
  echo "    1. start the app:  ./start-reel-vault.command"
  echo "    2. open           http://localhost:3210/connect"
  echo "    3. link the account, then run this script again."
  echo ""
  read -r -p "Press Return to close."
  exit 1
fi
echo "  account linked ✓"

# A cooldown means Instagram already pushed back. Respect it.
if echo "$HEALTH" | grep -q '"cooling_down": *true'; then
  echo ""
  echo "  Instagram is throttling this account right now — in cooldown."
  echo "  Try again in a few hours. Nothing was requested."
  read -r -p "Press Return to close."
  exit 0
fi

# ---------- 4. extract ----------
echo ""
python "$ROOT/pipeline/extract.py" --stats
echo ""
echo "Extracting up to $LIMIT items."
echo "Instagram lookups are paced ~25s apart on purpose — this is slow by design."
echo "Ctrl+C is safe; progress is saved as it goes."
echo ""

python "$ROOT/pipeline/extract.py" --limit "$LIMIT" $EXTRA_ARGS

echo ""
echo "───────────────────────────────────────────────"
echo " Done. To do more, run this again with a count:"
echo "   ./pipeline/run-extraction.command 100"
echo "───────────────────────────────────────────────"
read -r -p "Press Return to close."
