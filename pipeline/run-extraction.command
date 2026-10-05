#!/bin/bash
# Thin launcher — CLI loads .env.local itself.
cd "$(dirname "$0")/.."
exec pipeline/.venv/bin/python pipeline/extract.py "$@"
