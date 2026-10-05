"""Transcribe rules with a faked mlx_whisper — no real model."""
from __future__ import annotations

import sys
import types
from pathlib import Path

import reelvault.transcribe as tr


def test_short_text_dropped(tmp_path, monkeypatch):
    fake = types.ModuleType("mlx_whisper")

    def transcribe(path, path_or_hf_repo=None, **kw):
        return {"text": "hi", "language": "en"}

    fake.transcribe = transcribe
    monkeypatch.setitem(sys.modules, "mlx_whisper", fake)
    tr._model = None
    tr._backend = None

    out = tr.transcribe(tmp_path / "v.mp4")
    assert out == ""


def test_lang_prefix(tmp_path, monkeypatch):
    fake = types.ModuleType("mlx_whisper")

    def transcribe(path, path_or_hf_repo=None, **kw):
        return {
            "text": "これは十分な長さのテキストですよ",
            "language": "ja",
        }

    fake.transcribe = transcribe
    monkeypatch.setitem(sys.modules, "mlx_whisper", fake)
    tr._model = None
    tr._backend = None

    out = tr.transcribe(tmp_path / "v.mp4")
    assert out.startswith("[ja] ")
