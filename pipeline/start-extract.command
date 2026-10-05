#!/bin/bash
# Double-click to backfill reel content into the vault.
# Safe to stop (Ctrl-C) and re-run — it resumes where it left off.
cd "$(dirname "$0")/.."
[ -f .env.local ] && set -a && . ./.env.local && set +a
exec python3 pipeline/extract.py "$@"
