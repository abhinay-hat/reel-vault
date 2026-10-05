#!/bin/bash
# Local OpenAI-compatible LLM for enrichment (Qwen3-4B on mlx_lm.server).
cd "$(dirname "$0")/.."
exec pipeline/.venv/bin/mlx_lm.server \
  --model mlx-community/Qwen3-4B-Instruct-2507-4bit \
  --host 127.0.0.1 \
  --port 8090
