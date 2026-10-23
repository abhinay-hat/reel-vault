#!/bin/bash
# Double-click to backfill reel content into the vault.
# Safe to stop (Ctrl-C) and re-run — it resumes where it left off.
cd "$(dirname "$0")/.."
exec pipeline/.venv/bin/python pipeline/extract.py "$@"
