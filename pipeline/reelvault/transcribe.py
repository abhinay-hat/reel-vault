"""Speech-to-text: mlx-whisper on Apple Silicon, faster-whisper elsewhere."""
from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any, Optional

DEFAULT_MLX = "mlx-community/whisper-small-mlx"
WHISPER_MODEL = os.environ.get("REEL_VAULT_WHISPER_MODEL", DEFAULT_MLX)

_model: Any = None
_backend: Optional[str] = None


def _load() -> tuple[str, Any]:
    global _model, _backend
    if _model is not None and _backend is not None:
        return _backend, _model
    try:
        import mlx_whisper  # noqa: F401

        _backend = "mlx"
        _model = mlx_whisper
        return _backend, _model
    except Exception:
        pass
    from reelvault.cuda import add_nvidia_dlls

    add_nvidia_dlls()
    from faster_whisper import WhisperModel

    size = WHISPER_MODEL
    if "/" in size and "mlx" in size:
        size = "small"
    _backend = "faster"
    # CUDA when present (e.g. RTX box: REEL_VAULT_WHISPER_MODEL=large-v3-turbo), else CPU int8.
    try:
        _model = WhisperModel(size, device="cuda", compute_type="float16")
    except Exception:
        _model = WhisperModel(size, device="cpu", compute_type="int8")
    return _backend, _model


def filter_segments(segments: list[dict]) -> list[dict]:
    """Drop no-speech / low-confidence segments."""
    kept = []
    for s in segments:
        nsp = s.get("no_speech_prob")
        alp = s.get("avg_logprob")
        if nsp is not None and float(nsp) > 0.6:
            continue
        if alp is not None and float(alp) < -1.0:
            continue
        text = (s.get("text") or "").strip()
        if text:
            kept.append({**s, "text": text})
    return kept


def collapse_repeats(text: str) -> str:
    """Collapse any sentence repeated 3+ times in a row to one."""
    # Split on sentence boundaries; keep delimiters attached.
    parts = re.split(r"(?<=[.!?])\s+", text.strip())
    if not parts:
        return text
    out: list[str] = []
    i = 0
    while i < len(parts):
        cur = parts[i].strip()
        j = i + 1
        while j < len(parts) and parts[j].strip().lower() == cur.lower():
            j += 1
        # 3+ identical → keep one; 2 identical → keep both (not a hallucination loop)
        if j - i >= 3:
            out.append(cur)
        else:
            out.extend(p.strip() for p in parts[i:j] if p.strip())
        i = j
    return " ".join(out)


def _finalize(text: str, lang: str) -> str:
    text = collapse_repeats(text.strip())
    if len(text) < 15:
        return ""
    return f"[{lang}] {text}" if lang and lang != "en" else text


def transcribe(video: Path) -> str:
    """Return transcript text, or '' if too short / empty.

    Prefix `[<lang>] ` when language ≠ en. Load model once, lazily.
    """
    backend, model = _load()
    if backend == "mlx":
        repo = WHISPER_MODEL if "/" in WHISPER_MODEL else DEFAULT_MLX
        r = model.transcribe(
            str(video),
            path_or_hf_repo=repo,
            condition_on_previous_text=False,
        )
        raw_segs = list(r.get("segments") or [])
        segs = filter_segments(raw_segs)
        if segs:
            text = " ".join(s["text"] for s in segs).strip()
        elif raw_segs:
            text = ""  # every segment was filtered as no-speech/hallucination
        else:
            text = (r.get("text") or "").strip()
        lang = (r.get("language") or "").strip()
        return _finalize(text, lang)

    try:
        segments, info = model.transcribe(
            str(video),
            condition_on_previous_text=False,
            vad_filter=True,
        )
        segments = list(segments)
    except IndexError:
        return ""  # VAD removed all audio (music-only reel); faster-whisper indexes an empty list
    raw = []
    for s in segments:
        raw.append({
            "text": s.text,
            "no_speech_prob": getattr(s, "no_speech_prob", None),
            "avg_logprob": getattr(s, "avg_logprob", None),
        })
    kept = filter_segments(raw)
    text = " ".join(s["text"].strip() for s in kept).strip()
    lang = getattr(info, "language", None) or ""
    return _finalize(text, lang)
