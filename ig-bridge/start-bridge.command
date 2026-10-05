#!/bin/bash
# Double-click to start the Reel Vault Instagram helper on 127.0.0.1:8765.
# Creates an isolated venv on first run so macOS's system Python stays untouched.
set -e
cd "$(dirname "$0")"

PY="$(command -v python3 || true)"
if [ -z "$PY" ]; then
  echo "Python 3 is not installed. Install it from https://www.python.org/downloads/ and try again."
  read -r -p "Press Return to close."
  exit 1
fi

if [ ! -d ".venv" ]; then
  echo "First run: creating an isolated environment (one time)…"
  "$PY" -m venv .venv
fi

# shellcheck disable=SC1091
source .venv/bin/activate

echo "Installing helper dependencies…"
python -m pip install --upgrade pip >/dev/null
python -m pip install -r requirements.txt

echo ""
echo "Instagram helper running on http://127.0.0.1:8765"
echo "Keep this window open. Press Ctrl+C to stop."
echo ""
exec uvicorn main:app --host 127.0.0.1 --port 8765
