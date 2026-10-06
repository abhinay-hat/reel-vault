"""Transcribe rules with faked mlx_whisper / segment lists."""
from __future__ import annotations

import sys
import types
from pathlib import Path

import reelvault.transcribe as tr


def test_filter_segments_drops_no_speech():
    segs = [
        {"text": "hello there friends", "no_speech_prob": 0.1, "avg_logprob": -0.2},
        {"text": "noise", "no_speech_prob": 0.9, "avg_logprob": -0.1},
        {"text": "bad", "no_speech_prob": 0.1, "avg_logprob": -1.5},
    ]
    kept = tr.filter_segments(segs)
    assert len(kept) == 1
    assert "hello" in kept[0]["text"]


def test_collapse_repeats():
    text = "Thank you. Thank you. Thank you. Next tip."
    out = tr.collapse_repeats(text)
    assert out.count("Thank you.") == 1
    assert "Next tip." in out


def test_short_text_dropped(tmp_path, monkeypatch):
    fake = types.ModuleType("mlx_whisper")

    def transcribe(path, path_or_hf_repo=None, **kw):
        assert kw.get("condition_on_previous_text") is False
        return {"text": "hi", "language": "en", "segments": []}

    fake.transcribe = transcribe
    monkeypatch.setitem(sys.modules, "mlx_whisper", fake)
    tr._model = None
    tr._backend = None
    assert tr.transcribe(tmp_path / "v.mp4") == ""


def test_lang_prefix(tmp_path, monkeypatch):
    fake = types.ModuleType("mlx_whisper")

    def transcribe(path, path_or_hf_repo=None, **kw):
        return {
            "text": "これは十分な長さのテキストですよ",
            "language": "ja",
            "segments": [{
                "text": "これは十分な長さのテキストですよ",
                "no_speech_prob": 0.1,
                "avg_logprob": -0.2,
            }],
        }

    fake.transcribe = transcribe
    monkeypatch.setitem(sys.modules, "mlx_whisper", fake)
    tr._model = None
    tr._backend = None
    out = tr.transcribe(tmp_path / "v.mp4")
    assert out.startswith("[ja] ")


def test_all_segments_filtered_means_no_transcript(tmp_path, monkeypatch):
    # Music-only reel: Whisper invents lyrics; the filter drops them, and the
    # raw text must not sneak back in.
    fake = types.ModuleType("mlx_whisper")
    fake.transcribe = lambda *a, **k: {
        "text": "Thank you for watching, see you next time",
        "language": "en",
        "segments": [{"text": "Thank you for watching, see you next time",
                      "no_speech_prob": 0.9, "avg_logprob": -1.5}],
    }
    monkeypatch.setitem(sys.modules, "mlx_whisper", fake)
    tr._model = None
    tr._backend = None
    assert tr.transcribe(tmp_path / "v.mp4") == ""


def test_faster_whisper_vad_empty_index_error(tmp_path, monkeypatch):
    class M:
        def transcribe(self, *a, **k):
            raise IndexError("tuple index out of range")

    monkeypatch.setattr(tr, "_load", lambda: ("faster", M()))
    assert tr.transcribe(tmp_path / "v.mp4") == ""
