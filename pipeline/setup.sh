#!/usr/bin/env bash
# Idempotent one-time install for the zero-spend offline pipeline.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PIPE="$ROOT/pipeline"
VENV="$PIPE/.venv"
TESSDATA="$PIPE/tessdata"

echo "==> Reel Vault pipeline setup"
echo "    root: $ROOT"

if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew required. Install from https://brew.sh then re-run." >&2
  exit 1
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "==> installing ffmpeg"
  brew install ffmpeg
else
  echo "==> ffmpeg ok"
fi

if ! command -v tesseract >/dev/null 2>&1; then
  echo "==> installing tesseract"
  brew install tesseract
else
  echo "==> tesseract ok"
fi

pick_python() {
  if command -v uv >/dev/null 2>&1; then
    echo "uv"
    return
  fi
  for c in /opt/homebrew/bin/python3.12 /opt/homebrew/bin/python3.11 \
           python3.12 python3.11; do
    if command -v "$c" >/dev/null 2>&1; then
      echo "$c"
      return
    fi
  done
  echo ""
}

if [ ! -d "$VENV" ]; then
  PY="$(pick_python)"
  if [ -z "$PY" ]; then
    echo "==> installing python@3.12 via Homebrew"
    brew install python@3.12
    PY="/opt/homebrew/bin/python3.12"
  fi
  echo "==> creating venv with $PY"
  if [ "$PY" = "uv" ]; then
    uv venv --python 3.12 "$VENV"
  else
    # Never use /usr/bin/python3 — too old for mlx-lm.
    "$PY" -m venv "$VENV"
  fi
else
  echo "==> venv exists: $VENV"
fi

echo "==> install pipeline/requirements.txt"
if command -v uv >/dev/null 2>&1; then
  # uv venvs ship without pip; uv pip talks to the venv directly.
  uv pip install --python "$VENV/bin/python" -r "$PIPE/requirements.txt"
else
  "$VENV/bin/python" -m ensurepip --upgrade >/dev/null 2>&1 || true
  "$VENV/bin/python" -m pip install --upgrade pip
  "$VENV/bin/python" -m pip install -r "$PIPE/requirements.txt"
fi
# Record that uv created this venv (for the decisions log / re-runs).
touch "$VENV/.reelvault-setup"

mkdir -p "$TESSDATA"
BREW_PREFIX="$(brew --prefix)"
ENG_SRC="$BREW_PREFIX/share/tessdata/eng.traineddata"
if [ -f "$ENG_SRC" ] && [ ! -f "$TESSDATA/eng.traineddata" ]; then
  cp "$ENG_SRC" "$TESSDATA/eng.traineddata"
  echo "==> copied eng.traineddata"
fi

BASE="https://github.com/tesseract-ocr/tessdata_fast/raw/main"
for lang in hin tel; do
  dest="$TESSDATA/${lang}.traineddata"
  if [ ! -f "$dest" ]; then
    echo "==> downloading ${lang}.traineddata"
    curl -fsSL -o "$dest" "$BASE/${lang}.traineddata"
  else
    echo "==> ${lang}.traineddata present"
  fi
done

HF_CACHE="${HF_HOME:-${HOME}/.cache/huggingface}"
echo ""
echo "==> Hugging Face models cache: $HF_CACHE"
echo "    (whisper-small ~0.5 GB, Qwen3-4B-Instruct-4bit ~2.3 GB on first use)"
echo ""
echo "==> disk on repo volume:"
df -h "$ROOT"
echo ""
echo "Setup complete. Activate with: source pipeline/.venv/bin/activate"
