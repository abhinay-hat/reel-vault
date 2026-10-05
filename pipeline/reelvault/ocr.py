"""Apple Vision + Tesseract Indic OCR, merged across frames.

# Ported from reel-watcher (MIT, © 2026 Jacob Bruce): src/reel_watcher/study.py
"""
from __future__ import annotations

import re
import threading
from pathlib import Path
from typing import Optional

_OCR_LOCK = threading.Lock()
# Ported from reel-watcher (MIT, © 2026 Jacob Bruce): src/reel_watcher/study.py
_SECRET_RE = re.compile(
    r"\b(?:sk|pk|ghp|xox[a-z]|AKIA|AIza)[-_A-Za-z0-9]{12,}\b|"
    r"\b[A-Fa-f0-9]{32,}\b|"
    r"\b[A-Za-z0-9+/_-]{40,}\b"
)

_DEVANAGARI = re.compile(r"[\u0900-\u097F]")
_TELUGU = re.compile(r"[\u0C00-\u0C7F]")


def apple_vision_ocr(path: Path) -> str:
    """Apple Vision text recognition. '' if Vision is not importable.

    # Ported from reel-watcher (MIT, © 2026 Jacob Bruce): src/reel_watcher/study.py
    """
    try:
        import Vision
        from Foundation import NSURL, NSDictionary
    except Exception:
        return ""
    with _OCR_LOCK:
        req = Vision.VNRecognizeTextRequest.alloc().init()
        req.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelAccurate)
        req.setUsesLanguageCorrection_(True)
        h = Vision.VNImageRequestHandler.alloc().initWithURL_options_(
            NSURL.fileURLWithPath_(str(path)),
            NSDictionary.dictionary(),
        )
        ok = h.performRequests_error_([req], None)
        if not (ok[0] if isinstance(ok, tuple) else ok):
            return ""
        obs = sorted(req.results() or [], key=lambda o: -o.boundingBox().origin.y)
        lines = []
        for o in obs:
            c = o.topCandidates_(1)
            if c:
                lines.append(str(c[0].string()))
    txt = _SECRET_RE.sub("[redacted]", " ".join(lines))
    return re.sub(r"\s+", " ", txt).strip()[:500]


def tesseract_indic(path: Path, tessdata_dir: Path) -> str:
    """Tesseract hin+tel; keep only lines with Devanagari or Telugu."""
    try:
        import pytesseract
        from PIL import Image
    except Exception:
        return ""
    try:
        img = Image.open(path)
        raw = pytesseract.image_to_string(
            img,
            lang="hin+tel",
            config=f'--tessdata-dir "{tessdata_dir}"',
        )
    except Exception:
        return ""
    kept = []
    for line in (raw or "").splitlines():
        line = line.strip()
        if not line:
            continue
        if _DEVANAGARI.search(line) or _TELUGU.search(line):
            kept.append(line)
    return "\n".join(kept)


def _tesseract_all(path: Path, tessdata_dir: Path) -> str:
    try:
        import pytesseract
        from PIL import Image
    except Exception:
        return ""
    try:
        img = Image.open(path)
        raw = pytesseract.image_to_string(
            img,
            lang="eng+hin+tel",
            config=f'--tessdata-dir "{tessdata_dir}"',
        )
    except Exception:
        return ""
    txt = _SECRET_RE.sub("[redacted]", (raw or "").strip())
    return re.sub(r"\s+", " ", txt).strip()[:500]


def read_frame(path: Path, tessdata_dir: Path) -> str:
    """Vision + Indic lines; if Vision unavailable, Tesseract eng+hin+tel."""
    vision = apple_vision_ocr(path)
    if vision:
        indic = tesseract_indic(path, tessdata_dir)
        parts = [vision]
        if indic:
            parts.append(indic)
        text = "\n".join(parts)
    else:
        text = _tesseract_all(path, tessdata_dir)
    # Always redact — callers/tests may stub Vision without the redaction step.
    return _SECRET_RE.sub("[redacted]", text)


def _norm_line(t: str) -> str:
    return re.sub(r"\s+", " ", (t or "").lower()).strip()


def merge_frame_texts(texts: list[str]) -> str:
    """Split lines, keep first occurrence in time order, join, cap 2000 chars."""
    seen: set[str] = set()
    out: list[str] = []
    for text in texts:
        for line in (text or "").splitlines():
            line = line.strip()
            if not line:
                continue
            key = _norm_line(line)
            if not key or key in seen:
                continue
            seen.add(key)
            out.append(line)
    merged = "\n".join(out)
    return merged[:2000]
