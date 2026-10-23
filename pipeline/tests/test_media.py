"""Media helpers — pure + tiny PIL images. No network, no ffmpeg for unit bits."""
from __future__ import annotations

from pathlib import Path

from PIL import Image

from reelvault.media import (
    dedupe_frames,
    dhash_bits,
    pick_keyframe,
    pick_later_times,
    text_changed,
)


def test_pick_later_times_caps_and_spaces():
    cuts = [3.5, 4.0, 7.0, 10.0, 13.0, 16.0, 19.0, 22.0, 25.0, 28.0, 31.0]
    times = pick_later_times(cuts, duration=40.0)
    assert len(times) <= 10
    assert all(t < 40.0 for t in times)
    assert times == sorted(times)


def test_text_changed():
    assert text_changed("hello world", "hello world") is False
    assert text_changed("", "hello") is True
    assert text_changed("aaa bbb ccc", "zzz yyy xxx") is True


def test_dedupe_frames_keeps_text_change():
    # Identical hashes but different OCR → keep both.
    hashes = [0b1111, 0b1111]
    texts = ["TOP 3 TOOLS", "BOTTOM LIST"]
    uniq, _rep = dedupe_frames(hashes, texts, thr=9, cap=9)
    assert uniq == [0, 1]


def test_dedupe_frames_cap():
    hashes = list(range(20))
    texts = [f"t{i}" for i in range(20)]
    uniq, _ = dedupe_frames(hashes, texts, thr=0, cap=9)
    assert len(uniq) == 9


def test_dhash_and_keyframe(tmp_path):
    a = tmp_path / "a.png"
    b = tmp_path / "b.png"
    # Left-half white vs right-half white (checkerboards wash out under LANCZOS).
    img_a = Image.new("RGB", (64, 64), (0, 0, 0))
    img_b = Image.new("RGB", (64, 64), (0, 0, 0))
    for y in range(64):
        for x in range(32):
            img_a.putpixel((x, y), (255, 255, 255))
            img_b.putpixel((x + 32, y), (255, 255, 255))
    img_a.save(a)
    img_b.save(b)
    ha, hb = dhash_bits(a), dhash_bits(b)
    assert isinstance(ha, int)
    assert ha != hb

    kf = pick_keyframe([(0.0, a), (1.1, b), (2.0, a)])
    assert kf == b
