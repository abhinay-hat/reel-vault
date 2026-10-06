@echo off
rem Windows/CUDA runner (RTX box). Clean PATH: a Codex bin mount point on the
rem user PATH makes pip/python fail with WinError 448.
set "PATH=C:\Windows\System32;C:\Windows;C:\Program Files\Tesseract-OCR;%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-8.1-full_build\bin;%~dp0.venv\Scripts"
if not defined REEL_VAULT_WHISPER_MODEL set "REEL_VAULT_WHISPER_MODEL=large-v3-turbo"
set "PYTHONIOENCODING=utf-8"
set "PYTHONUNBUFFERED=1"
cd /d "%~dp0.."
"%~dp0.venv\Scripts\python.exe" "%~dp0extract.py" %*
