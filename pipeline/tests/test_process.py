"""End-to-end process_item with fakes — no network, no models."""
from __future__ import annotations

import hashlib
import sqlite3
from pathlib import Path

from PIL import Image

from reelvault import db
from reelvault.fetch_apify import FetchResult
from reelvault.process import process_item


def _seed(tmp_path: Path):
    path = tmp_path / "p.db"
    con = sqlite3.connect(path)
    con.row_factory = sqlite3.Row
    con.execute(
        """
        create table items (
          id text primary key, url text, source text, title text,
          author text, thumbnail text, summary text, category text,
          tags text, notes text, origin text, created_at text, added_at text,
          media_file text, video text, video_file text
        )
        """
    )
    con.commit()
    db.ensure_schema(con)
    return con


def _insert(con, **kw):
    cols = {
        "id": "item-1",
        "url": "https://www.instagram.com/reel/ABC/",
        "source": "instagram",
        "title": "Shared by 1",
        "author": None,
        "thumbnail": None,
        "summary": None,
        "category": "uncategorized",
        "tags": "[]",
        "notes": None,
        "origin": "dm_shared",
        "created_at": "2026-01-01T00:00:00Z",
        "added_at": "2026-01-02T00:00:00Z",
        "content_status": "fetched",
        "video": "https://cdn.example/v.mp4",
    }
    cols.update(kw)
    con.execute(
        f"insert into items ({','.join(cols)}) values ({','.join('?' for _ in cols)})",
        list(cols.values()),
    )
    con.commit()
    return con.execute("select * from items where id=?", (cols["id"],)).fetchone()


def _stub_video_pipeline(monkeypatch, media: Path, *, vision_raise=False):
    monkeypatch.setattr("reelvault.process.MEDIA_DIR", media)
    monkeypatch.setattr("reelvault.db.MEDIA_DIR", media)

    def fake_download(url, dest: Path):
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(b"\x00" * 2000)
        return dest

    monkeypatch.setattr("reelvault.process.download", fake_download)
    monkeypatch.setattr("reelvault.process.probe", lambda _p: {"duration": 6.0})
    monkeypatch.setattr("reelvault.process.detect_cuts", lambda *_a, **_k: [])
    monkeypatch.setattr("reelvault.process.pick_later_times", lambda *_a, **_k: [])

    def fake_frames(video, times, dest, prefix="f"):
        dest.mkdir(parents=True, exist_ok=True)
        out = []
        for t in times[:3] or [1.0]:
            p = dest / f"f_{int(t * 100):06d}.jpg"
            Image.new("RGB", (64, 64), (10, 10, 10)).save(p)
            out.append((t, p))
        return out

    monkeypatch.setattr("reelvault.process.extract_frames_at", fake_frames)
    monkeypatch.setattr("reelvault.process.dhash_bits", lambda *_a, **_k: 1)

    calls = {"tess": 0}

    def vision(path):
        if vision_raise:
            raise RuntimeError("vision boom")
        return "TOP 3 AI TOOLS"

    def tess(path, tessdata_dir):
        calls["tess"] += 1
        return ""

    monkeypatch.setattr("reelvault.process.frame_ocr", vision)
    monkeypatch.setattr("reelvault.process.tesseract_indic", tess)
    monkeypatch.setattr(
        "reelvault.process.whisper_transcribe",
        lambda *_a, **_k: "Reel Vault smoke test words here",
    )
    return calls


def test_video_item(tmp_path, monkeypatch):
    media = tmp_path / "media"
    media.mkdir()
    calls = _stub_video_pipeline(monkeypatch, media)
    con = _seed(tmp_path)
    row = _insert(con)
    process_item(
        con, row,
        FetchResult(video_url="https://cdn.example/v.mp4", caption="c"),
        keep_media=False,
        tessdata_dir=tmp_path,
    )
    fresh = con.execute("select * from items where id='item-1'").fetchone()
    assert fresh["content_status"] == "transcribed"
    assert "TOP 3" in (fresh["ocr_text"] or "")
    assert "smoke test" in (fresh["transcript"] or "")
    assert fresh["video_file"] is None
    assert fresh["media_file"]
    md5 = hashlib.md5(b"item-1").hexdigest()
    assert not (media / f"{md5}.mp4").exists()
    assert calls["tess"] <= 9


def test_image_item(tmp_path, monkeypatch):
    media = tmp_path / "media"
    media.mkdir()
    monkeypatch.setattr("reelvault.process.MEDIA_DIR", media)

    def fake_download(url, dest: Path):
        dest.parent.mkdir(parents=True, exist_ok=True)
        Image.new("RGB", (32, 32), (20, 20, 20)).save(dest)
        return dest

    monkeypatch.setattr("reelvault.process.download", fake_download)
    monkeypatch.setattr("reelvault.process.frame_ocr", lambda *_a: "SLIDE TEXT")
    monkeypatch.setattr("reelvault.process.tesseract_indic", lambda *_a, **_k: "")
    monkeypatch.setattr("reelvault.process.dhash_bits", lambda *_a, **_k: 1)

    con = _seed(tmp_path)
    row = _insert(con, video=None, id="img-1", url="https://www.instagram.com/p/XYZ/")
    process_item(
        con, row,
        FetchResult(image_urls=["https://cdn.example/1.jpg", "https://cdn.example/2.jpg"]),
        keep_media=False,
        tessdata_dir=tmp_path,
    )
    fresh = con.execute("select * from items where id='img-1'").fetchone()
    assert fresh["content_status"] == "transcribed"
    assert "SLIDE TEXT" in (fresh["ocr_text"] or "")


def test_no_media_without_fetch_not_transcribed(tmp_path, monkeypatch):
    media = tmp_path / "media"
    media.mkdir()
    monkeypatch.setattr("reelvault.process.MEDIA_DIR", media)
    con = _seed(tmp_path)
    row = _insert(con, video=None, id="stale", content_status="fetched")
    process_item(con, row, None, keep_media=False, tessdata_dir=tmp_path, caption_only_ok=False)
    fresh = con.execute("select * from items where id='stale'").fetchone()
    assert fresh["content_status"] == "failed"
    assert "re-fetch" in (fresh["content_error"] or "")


def test_caption_only_ok_for_sidecar(tmp_path, monkeypatch):
    media = tmp_path / "media"
    media.mkdir()
    monkeypatch.setattr("reelvault.process.MEDIA_DIR", media)
    con = _seed(tmp_path)
    row = _insert(con, video=None, id="cap")
    process_item(con, row, None, keep_media=False, tessdata_dir=tmp_path, caption_only_ok=True)
    fresh = con.execute("select content_status from items where id='cap'").fetchone()
    assert fresh["content_status"] == "transcribed"


def test_failed_download(tmp_path, monkeypatch):
    media = tmp_path / "media"
    media.mkdir()
    monkeypatch.setattr("reelvault.process.MEDIA_DIR", media)
    monkeypatch.setattr("reelvault.process.download", lambda *_a, **_k: None)
    con = _seed(tmp_path)
    row = _insert(con)
    process_item(
        con, row,
        FetchResult(video_url="https://cdn.example/v.mp4"),
        keep_media=False,
        tessdata_dir=tmp_path,
    )
    fresh = con.execute("select * from items where id='item-1'").fetchone()
    assert fresh["content_status"] == "failed"


def test_media_file_only_if_empty(tmp_path, monkeypatch):
    media = tmp_path / "media"
    media.mkdir()
    monkeypatch.setattr("reelvault.process.MEDIA_DIR", media)

    def fake_download(url, dest: Path):
        dest.parent.mkdir(parents=True, exist_ok=True)
        Image.new("RGB", (32, 32), (1, 1, 1)).save(dest)
        return dest

    monkeypatch.setattr("reelvault.process.download", fake_download)
    monkeypatch.setattr("reelvault.process.frame_ocr", lambda *_a: "x")
    monkeypatch.setattr("reelvault.process.tesseract_indic", lambda *_a, **_k: "")
    monkeypatch.setattr("reelvault.process.dhash_bits", lambda *_a, **_k: 1)

    con = _seed(tmp_path)
    row = _insert(
        con, id="keep-m", video=None, media_file="existing.jpg",
        url="https://www.instagram.com/p/KEEP/",
    )
    process_item(
        con, row,
        FetchResult(image_urls=["https://cdn.example/1.jpg"]),
        keep_media=False,
        tessdata_dir=tmp_path,
    )
    fresh = con.execute("select media_file from items where id='keep-m'").fetchone()
    assert fresh["media_file"] == "existing.jpg"


def test_safe_process_continues_after_exception(tmp_path, monkeypatch):
    """One boom must mark failed, delete video, and let the next item run."""
    import extract as extract_mod

    media = tmp_path / "media"
    media.mkdir()
    monkeypatch.setattr("reelvault.process.MEDIA_DIR", media)
    monkeypatch.setattr("reelvault.db.MEDIA_DIR", media)
    _stub_video_pipeline(monkeypatch, media, vision_raise=True)

    con = _seed(tmp_path)
    a = _insert(con, id="bad-1", url="https://www.instagram.com/reel/BAD/")
    b = _insert(con, id="ok-2", url="https://www.instagram.com/reel/OK2/")
    # First raises via vision; second succeeds after we clear the raise.
    extract_mod._safe_process(
        con, a, FetchResult(video_url="https://cdn.example/v.mp4"),
        keep_media=False, tessdata=tmp_path,
    )
    fresh_a = con.execute("select * from items where id='bad-1'").fetchone()
    assert fresh_a["content_status"] == "failed"
    assert "process:" in (fresh_a["content_error"] or "")
    md5 = hashlib.md5(b"bad-1").hexdigest()
    assert not (media / f"{md5}.mp4").exists()

    monkeypatch.setattr("reelvault.process.frame_ocr", lambda *_a: "OK TEXT")
    extract_mod._safe_process(
        con, b, FetchResult(video_url="https://cdn.example/v2.mp4"),
        keep_media=False, tessdata=tmp_path,
    )
    fresh_b = con.execute("select content_status from items where id='ok-2'").fetchone()
    assert fresh_b["content_status"] == "transcribed"


def test_tesseract_only_on_unique_frames(tmp_path, monkeypatch):
    media = tmp_path / "media"
    media.mkdir()
    calls = _stub_video_pipeline(monkeypatch, media)
    # Identical hashes + identical vision text → one unique frame.
    monkeypatch.setattr("reelvault.process.dhash_bits", lambda *_a, **_k: 42)
    con = _seed(tmp_path)
    row = _insert(con)
    process_item(
        con, row,
        FetchResult(video_url="https://cdn.example/v.mp4"),
        keep_media=False,
        tessdata_dir=tmp_path,
    )
    assert calls["tess"] == 1
