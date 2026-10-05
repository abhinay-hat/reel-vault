"""Apple Vision + Tesseract Indic OCR, merged across frames.

# Ported from reel-watcher (MIT, © 2026 Jacob Bruce): src/reel_watcher/study.py
"""
from __future__ import annotations

import re
import threading
from pathlib import Path

_OCR_LOCK = threading.Lock()
# Ported from reel-watcher (MIT, © 2026 Jacob Bruce): src/reel_watcher/study.py
_SECRET_RE = re.compile(
    r"\b(?:sk|pk|ghp|xox[a-z]|AKIA|AIza)[-_A-Za-z0-9]{12,}\b|"
    r"\b[A-Fa-f0-9]{32,}\b|"
    r"\b[A-Za-z0-9+/_-]{40,}\b"
)

_DEVANAGARI = re.compile(r"[\u0900-\u097F]")
_TELUGU = re.compile(r"[\u0C00-\u0C7F]")
_LETTER = re.compile(r"[^\W\d_]", re.UNICODE)


def apple_vision_ocr(path: Path) -> str:
    """Apple Vision: one line per observation, top→bottom, cap 1000 chars.

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
                line = re.sub(r"\s+", " ", str(c[0].string())).strip()
                if line:
                    lines.append(line)
    txt = _SECRET_RE.sub("[redacted]", "\n".join(lines))
    return txt[:1000]


def _indic_letter_stats(text: str) -> tuple[int, int]:
    """Return (indic_letters, total_letters)."""
    indic = 0
    total = 0
    for ch in text:
        if not _LETTER.match(ch):
            continue
        total += 1
        if _DEVANAGARI.match(ch) or _TELUGU.match(ch):
            indic += 1
    return indic, total


def _keep_indic_line(text: str) -> bool:
    indic, total = _indic_letter_stats(text)
    if indic < 3 or total == 0:
        return False
    return (indic / total) >= 0.60


def tesseract_indic(path: Path, tessdata_dir: Path) -> str:
    """Tesseract hin+tel via image_to_data; conf≥70; Indic-heavy lines only."""
    try:
        import pytesseract
        from PIL import Image
    except Exception:
        return ""
    try:
        img = Image.open(path)
        if img.width < 720:
            img = img.resize((img.width * 2, img.height * 2), Image.LANCZOS)
        data = pytesseract.image_to_data(
            img,
            lang="hin+tel",
            config=f'--tessdata-dir "{tessdata_dir}"',
            output_type=pytesseract.Output.DICT,
        )
    except Exception:
        return ""

    # Group words by (block, par, line).
    lines: dict[tuple[int, int, int], list[str]] = {}
    n = len(data.get("text") or [])
    for i in range(n):
        try:
            conf = float(data["conf"][i])
        except (ValueError, TypeError, KeyError):
            continue
        if conf < 70:
            continue
        word = (data["text"][i] or "").strip()
        if not word:
            continue
        key = (
            int(data["block_num"][i]),
            int(data["par_num"][i]),
            int(data["line_num"][i]),
        )
        lines.setdefault(key, []).append(word)

    kept = []
    for key in sorted(lines):
        line = " ".join(lines[key]).strip()
        if _keep_indic_line(line):
            kept.append(line)
    return "\n".join(kept)


def _tesseract_all(path: Path, tessdata_dir: Path) -> str:
    """Fallback when Vision is unavailable — eng+hin+tel string OCR."""
    try:
        import pytesseract
        from PIL import Image
    except Exception:
        return ""
    try:
        img = Image.open(path)
        if img.width < 720:
            img = img.resize((img.width * 2, img.height * 2), Image.LANCZOS)
        raw = pytesseract.image_to_string(
            img,
            lang="eng+hin+tel",
            config=f'--tessdata-dir "{tessdata_dir}"',
        )
    except Exception:
        return ""
    lines = []
    for line in (raw or "").splitlines():
        line = re.sub(r"\s+", " ", line).strip()
        if line:
            lines.append(line)
    txt = _SECRET_RE.sub("[redacted]", "\n".join(lines))
    return txt[:1000]


def read_frame(path: Path, tessdata_dir: Path) -> str:
    """Vision + Indic; if Vision unavailable, Tesseract eng+hin+tel.

    Prefer process.py's Vision→dedupe→Indic path for videos; this helper
    remains for simple call sites and tests.
    """
    vision = apple_vision_ocr(path)
    if vision:
        indic = tesseract_indic(path, tessdata_dir)
        parts = [vision]
        if indic:
            parts.append(indic)
        text = "\n".join(parts)
    else:
        text = _tesseract_all(path, tessdata_dir)
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
