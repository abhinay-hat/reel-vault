"""OCR merge / filter / redaction — Vision/Tesseract faked."""
from __future__ import annotations

from pathlib import Path

from reelvault import ocr


def test_merge_dedupe_and_cap():
    texts = [
        "Line A\nLine B",
        "line a\nLine C",  # Line A dup (case/space)
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

    monkeypatch.setattr(ocr, "apple_vision_ocr", fake_vision)
    monkeypatch.setattr(ocr, "tesseract_indic", lambda *_a, **_k: "")
    out = ocr.read_frame(tmp_path / "x.jpg", tmp_path)
    assert "sk-abcdefghijklmnopqrstuvwxyz012345" not in out
    assert "[redacted]" in out


def test_indic_script_filter(monkeypatch, tmp_path):
    # Simulate pytesseract returning mixed lines.
    class FakeImg:
        pass

    def fake_image_to_string(img, lang=None, config=None):
        return "English only\nनमस्ते दुनिया\nతెలుగు లైన్\nplain"

    monkeypatch.setitem(__import__("sys").modules, "pytesseract", type("P", (), {
        "image_to_string": staticmethod(fake_image_to_string),
    })())
    monkeypatch.setattr("PIL.Image.open", lambda *_a, **_k: FakeImg())

    out = ocr.tesseract_indic(tmp_path / "x.jpg", tmp_path)
    assert "नमस्ते" in out
    assert "తెలుగు" in out
    assert "English" not in out
