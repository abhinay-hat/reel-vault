"""Speech-to-text: mlx-whisper on Apple Silicon, faster-whisper elsewhere."""
from __future__ import annotations

import os
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
    from faster_whisper import WhisperModel

    # Legacy size names like "small" for CPU fallback.
    size = WHISPER_MODEL
    if "/" in size:
        size = "small"
    _backend = "faster"
    _model = WhisperModel(size, device="cpu", compute_type="int8")
    return _backend, _model


def transcribe(video: Path) -> str:
    """Return transcript text, or '' if too short / empty.

    Prefix `[<lang>] ` when language ≠ en. Load model once, lazily.
    """
    backend, model = _load()
    if backend == "mlx":
        repo = WHISPER_MODEL if "/" in WHISPER_MODEL else DEFAULT_MLX
        r = model.transcribe(str(video), path_or_hf_repo=repo)
        text = (r.get("text") or "").strip()
        lang = (r.get("language") or "").strip()
        if len(text) < 15:
            return ""
        return f"[{lang}] {text}" if lang and lang != "en" else text

    segments, info = model.transcribe(str(video))
    text = " ".join(s.text.strip() for s in segments).strip()
    if len(text) < 15:
        return ""
    lang = getattr(info, "language", None) or ""
    return f"[{lang}] {text}" if lang and lang != "en" else text
