@echo off
rem Windows/RTX box: Vite + Hono app on :3210 using Ollama on the 5090 for enrichment.
set "PATH=C:\Windows\System32;C:\Windows;C:\Program Files\nodejs;C:\Program Files\Git\cmd"
set "LLM_PROVIDER=local"
set "LLM_BASE_URL=http://127.0.0.1:11434/v1"
set "LLM_MODEL=qwen3:30b-a3b-instruct-2507-q4_K_M"
cd /d "%~dp0.."
npm run dev
