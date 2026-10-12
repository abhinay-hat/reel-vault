"""Apple Vision + Tesseract Indic OCR, merged across frames.

# Ported from reel-watcher (MIT, © 2026 Jacob Bruce): src/reel_watcher/study.py
"""
from __future__ import annotations

import re
import sys
import threading
from pathlib import Path

_OCR_LOCK = threading.Lock()
# Ported from reel-watcher (MIT, © 2026 Jacob Bruce): src/reel_watcher/study.py
_SECRET_RE = re.compile(
    r"\b(?:sk|pk|ghp|xox[a-z]|AKIA|AIza)[-_A-Za-z0-9]{12,}\b|"
    r"\b[A-Fa-f0-9]{32,}\b|"
    # No "/" and not inside a URL path: long repo paths were being redacted
    # ("raw.githubusercontent.[redacted].md"), which wrecked saved links.
    # Needs a digit: OCR that lost its spaces ("Beforeenrollinglookup...") is
    # 40+ letters too, and is content, not a credential.
    r"(?<![/.\w])(?=[A-Za-z+_-]*\d)[A-Za-z0-9+_-]{40,}\b"
)

_DEVANAGARI = re.compile(r"[\u0900-\u097F]")
_TELUGU = re.compile(r"[\u0C00-\u0C7F]")
_LETTER = re.compile(r"[^\W\d_]", re.UNICODE)


def _rapid_ocr(path: Path) -> str:
    """Non-Mac stand-in for Vision: RapidOCR 3 (PP-OCRv5), same line/redact/cap contract.

    v5 over the v4 default: on screen-recorded web pages v4 dropped the spaces in
    2/3 of long lines ("Beforeenrolling,lookupyour..."); v5 ~1/5, 2.7x faster.
    """
    global _RAPID
    try:
        if _RAPID is None:
            from rapidocr import RapidOCR

            # ponytail: CPU on purpose. Measured on the RTX 5090 box: CUDA gave the
            # same 0.45 s/frame (small models; pre/post-processing dominates) and
            # added a 77 s model load per process. Throughput comes from running
            # extract.py shards in parallel instead.
            _RAPID = RapidOCR()
        r = _RAPID(str(path))
    except Exception:
        return ""
    if r.txts is None:
        return ""
    # boxes[i][0] is the top-left corner; sort top→bottom, then left→right.
    rows = sorted(zip(r.boxes, r.txts, r.scores), key=lambda x: (x[0][0][1], x[0][0][0]))
    lines = [re.sub(r"\s+", " ", t).strip() for _b, t, sc in rows if float(sc) >= 0.5]
    txt = _SECRET_RE.sub("[redacted]", "\n".join(l for l in lines if l))
    return txt[:1000]


_RAPID = None


def frame_ocr(path: Path) -> str:
    """Apple Vision: one line per observation, top→bottom, cap 1000 chars.

    # Ported from reel-watcher (MIT, © 2026 Jacob Bruce): src/reel_watcher/study.py
    """
    if sys.platform != "darwin":
        return _rapid_ocr(path)
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


class VisionUnavailable(RuntimeError):
    """Vision silently returns nothing under heavy swap; saving would lose OCR."""


def _vision_canary() -> bool:
    import tempfile
    from PIL import Image, ImageDraw, ImageFont

    with tempfile.TemporaryDirectory() as td:
        p = Path(td) / "canary.png"
        im = Image.new("RGB", (720, 400), "white")
        try:
            font = ImageFont.truetype(
                "arialbd.ttf" if sys.platform == "win32" else "/System/Library/Fonts/Supplemental/Arial Bold.ttf", 72
            )
        except OSError:
            font = ImageFont.load_default(size=72)
        ImageDraw.Draw(im).text((40, 150), "REEL VAULT", fill="black", font=font)
        im.save(p)
        return "VAULT" in frame_ocr(p).upper()


def check_vision(vision_texts: list[str]) -> None:
    """All frames empty is normal for text-less reels; only raise if Vision itself is down."""
    if vision_texts and not any(vision_texts) and not _vision_canary():
        raise VisionUnavailable("OCR engine returned no text for a known test image")


def _tess_config(tessdata_dir: Path) -> str:
    # pytesseract splits config with shlex(posix=False) on Windows, which keeps
    # quotes literally and breaks the path; pass it unquoted there.
    if sys.platform == "win32":
        return f"--tessdata-dir {Path(tessdata_dir).as_posix()}"
    return f'--tessdata-dir "{tessdata_dir}"'


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
    # Real lines are one script; hin+tel garbage mixes both ("(शा, ౧౦ भाव").
    if _DEVANAGARI.search(text) and _TELUGU.search(text):
        return False
    # Need 2+ distinct words of 2+ letters; drops "అ అ అ -" style repeats.
    # Whitespace tokens: \w skips Indic vowel signs, so regex words split mid-word.
    words = {w for w in text.split() if len(w) >= 2 and (_DEVANAGARI.search(w) or _TELUGU.search(w))}
    if len(words) < 2:
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
            config=_tess_config(tessdata_dir),
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
            config=_tess_config(tessdata_dir),
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
    vision = frame_ocr(path)
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
