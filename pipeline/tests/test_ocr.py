"""OCR merge / filter / redaction — Vision/Tesseract faked."""
from __future__ import annotations

from pathlib import Path

from reelvault import ocr


def test_merge_dedupe_and_cap():
    texts = [
        "Line A\nLine B",
        "line a\nLine C",
        "X" * 3000,
    ]
    merged = ocr.merge_frame_texts(texts)
    assert "Line A" in merged
    assert "Line B" in merged
    assert "Line C" in merged
    assert len(merged) <= 2000


def test_secret_redaction(monkeypatch, tmp_path):
    def fake_vision(path: Path) -> str:
        return "token sk-abcdefghijklmnopqrstuvwxyz012345 and done"

    monkeypatch.setattr(ocr, "frame_ocr", fake_vision)
    monkeypatch.setattr(ocr, "tesseract_indic", lambda *_a, **_k: "")
    out = ocr.read_frame(tmp_path / "x.jpg", tmp_path)
    assert "sk-abcdefghijklmnopqrstuvwxyz012345" not in out
    assert "[redacted]" in out


def test_noise_line_rejected():
    # Mixed-script garbage: few Indic letters among Latin → reject.
    assert ocr._keep_indic_line("ToP3AITOOLS 0౧౩౧4!") is False
    assert ocr._keep_indic_line("hello") is False


def test_real_hindi_line_kept(monkeypatch, tmp_path):
    class FakeImg:
        width = 800
        height = 600

        def resize(self, *a, **k):
            return self

    def fake_image_to_data(img, lang=None, config=None, output_type=None):
        # One Hindi line with high confidence.
        return {
            "text": ["नमस्ते", "दुनिया", "hi"],
            "conf": ["90", "88", "95"],
            "block_num": [1, 1, 1],
            "par_num": [1, 1, 1],
            "line_num": [1, 1, 2],
        }

    class FakePyt:
        class Output:
            DICT = "dict"

        image_to_data = staticmethod(fake_image_to_data)

    monkeypatch.setitem(__import__("sys").modules, "pytesseract", FakePyt())
    monkeypatch.setattr("PIL.Image.open", lambda *_a, **_k: FakeImg())

    out = ocr.tesseract_indic(tmp_path / "x.jpg", tmp_path)
    assert "नमस्ते" in out
    assert "hi" not in out  # Latin-only line dropped


def test_mixed_script_and_repeat_noise_rejected():
    # Real Tesseract hin+tel garbage seen on English reels (2026-10-06 run).
    assert ocr._keep_indic_line("(शा, ౧౦ भाव") is False
    assert ocr._keep_indic_line("అ అ అ -") is False
    assert ocr._keep_indic_line("क्योंकि इंडिया में") is True
    assert ocr._keep_indic_line("నేను తెలుగు మాట్లాడతాను") is True


def test_check_vision_raises_only_when_canary_fails(monkeypatch):
    import pytest
    monkeypatch.setattr(ocr, "frame_ocr", lambda _p: "")
    with pytest.raises(ocr.VisionUnavailable):
        ocr.check_vision(["", ""])
    ocr.check_vision([])  # no frames: nothing to judge
    ocr.check_vision(["", "text"])  # some text: Vision is up
    monkeypatch.setattr(ocr, "frame_ocr", lambda _p: "REEL VAULT")
    ocr.check_vision(["", ""])  # text-less reel, Vision healthy


def test_urls_survive_redaction():
    url = "https://raw.githubusercontent.com/Panniantong/Agent-Reach/main/docs/README_en.md"
    assert ocr._SECRET_RE.sub("[redacted]", url) == url
    long_tok = "A" * 20 + "b9" * 15
    assert ocr._SECRET_RE.sub("[redacted]", f"key {long_tok} end") == "key [redacted] end"
