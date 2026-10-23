"""Apify fetcher tests with a fake HTTP session — no network."""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

import pytest

from reelvault import db
from reelvault.fetch_apify import (
    FetchError,
    fetch_batch,
    map_item,
    normalize_url,
)
from reelvault.guardrails import GuardrailError


REAL_URL = (
    "https://www.instagram.com/reel/DY4ZdXVP1qa/"
    "?id=3906984645824043674_50056993869&is_sponsored=false&extra=1"
)


def test_normalize_url_strips_query():
    out = normalize_url(REAL_URL)
    assert out == ("reel", "DY4ZdXVP1qa", "https://www.instagram.com/reel/DY4ZdXVP1qa/")
    assert normalize_url("https://example.com/reel/x/") is None
    assert normalize_url("https://www.instagram.com/reels/AbC/")[0] == "reel"


def test_map_reel_item():
    fr = map_item({
        "shortCode": "AAA",
        "caption": "Hello\nworld",
        "videoUrl": "https://cdn.example/v.mp4",
        "displayUrl": "https://cdn.example/t.jpg",
        "ownerUsername": "alice",
        "videoDuration": 12.5,
        "musicInfo": {
            "song_name": "Song",
            "artist_name": "Artist",
            "uses_original_audio": False,
        },
        "timestamp": "2026-01-01T00:00:00.000Z",
    })
    assert fr.caption.startswith("Hello")
    assert fr.video_url.endswith(".mp4")
    assert fr.author == "alice"
    assert fr.duration_s == 12.5
    music = json.loads(fr.music)
    assert music["song"] == "Song"
    assert fr.image_urls[0].endswith("t.jpg")


def test_map_carousel_video_child():
    fr = map_item({
        "shortCode": "BBB",
        "childPosts": [
            {"displayUrl": "https://cdn.example/1.jpg"},
            {"displayUrl": "https://cdn.example/2.jpg", "videoUrl": "https://cdn.example/c.mp4"},
        ],
        "images": ["https://cdn.example/extra.jpg"],
    })
    assert fr.video_url.endswith("c.mp4")
    assert len(fr.image_urls) <= 10
    assert "https://cdn.example/1.jpg" in fr.image_urls


def test_map_image_only():
    fr = map_item({
        "shortCode": "CCC",
        "displayUrl": "https://cdn.example/only.jpg",
        "caption": "pic",
    })
    assert fr.video_url is None
    assert fr.image_urls == ["https://cdn.example/only.jpg"]


def test_map_error():
    fr = map_item({"error": "not_found", "errorDescription": "gone"})
    assert fr.error == "gone"


def _seed(tmp_path: Path) -> sqlite3.Connection:
    path = tmp_path / "f.db"
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


def _row(con, **kw):
    cols = {
        "id": "id1",
        "url": REAL_URL,
        "source": "instagram",
        "title": "Shared by 123",
        "author": None,
        "thumbnail": None,
        "summary": None,
        "category": "uncategorized",
        "tags": "[]",
        "notes": None,
        "origin": "dm_shared",
        "created_at": "2026-01-01T00:00:00Z",
        "added_at": "2026-01-02T00:00:00Z",
        "content_status": "pending",
    }
    cols.update(kw)
    con.execute(
        f"insert into items ({','.join(cols)}) values ({','.join('?' for _ in cols)})",
        list(cols.values()),
    )
    con.commit()
    return con.execute("select * from items where id=?", (cols["id"],)).fetchone()


class FakeSession:
    """Minimal requests.Session stand-in."""

    def __init__(self, *, limits_used=0.0, items=None, status="SUCCEEDED", refuse_post=False):
        self.limits_used = limits_used
        self.items = items or []
        self.status = status
        self.refuse_post = refuse_post
        self.posts: list[Any] = []

    def get(self, url, **kw):
        if "users/me/limits" in url:
            return _Resp(200, {
                "data": {
                    "current": {"monthlyUsageUsd": self.limits_used},
                    "limits": {"maxMonthlyUsageUsd": 5},
                    "monthlyUsageCycle": {"endAt": "2026-11-01T00:00:00.000Z"},
                }
            })
        if "actor-runs/" in url:
            return _Resp(200, {
                "data": {
                    "id": "run1",
                    "status": self.status,
                    "defaultDatasetId": "ds1",
                    "usageTotalUsd": 0.01,
                    "statusMessage": "ok" if self.status == "SUCCEEDED" else "boom",
                }
            })
        if "datasets/" in url:
            return _Resp(200, self.items)
        return _Resp(404, {})

    def post(self, url, **kw):
        self.posts.append(url)
        if self.refuse_post:
            raise AssertionError("POST should not happen")
        return _Resp(201, {
            "data": {
                "id": "run1",
                "status": "SUCCEEDED",
                "defaultDatasetId": "ds1",
                "usageTotalUsd": 0.01,
            }
        })


class _Resp:
    def __init__(self, status_code, payload):
        self.status_code = status_code
        self._payload = payload
        self.headers = {}
        self.text = json.dumps(payload)

    def raise_for_status(self):
        if self.status_code >= 400:
            raise Exception(f"http {self.status_code}")

    def json(self):
        return self._payload


def test_fetch_batch_title_thumbnail_ledger(tmp_path, monkeypatch):
    monkeypatch.setattr("reelvault.fetch_apify.time.sleep", lambda *_a, **_k: None)
    con = _seed(tmp_path)
    row = _row(con)
    items = [{
        "shortCode": "DY4ZdXVP1qa",
        "caption": "Real title line\nmore",
        "videoUrl": "https://cdn.example/v.mp4",
        "displayUrl": "https://cdn.example/thumb.jpg",
        "ownerUsername": "bob",
        "videoDuration": 8,
    }]
    sess = FakeSession(items=items)
    out, counts = fetch_batch(con, [row], "tok", dry_run=False, session=sess)
    assert "DY4ZdXVP1qa" in out
    assert counts["fetched"] == 1
    fresh = con.execute("select * from items where id='id1'").fetchone()
    assert fresh["content_status"] == "fetched"
    assert fresh["fetcher"] == "apify"
    assert fresh["title"] == "Real title line"
    assert fresh["thumbnail"] == "https://cdn.example/thumb.jpg"
    assert fresh["video"] == "https://cdn.example/v.mp4"
    ledger = con.execute("select * from quota_ledger").fetchone()
    assert ledger["provider"] == "apify"
    assert ledger["run_id"] == "run1"


def test_title_kept_when_real(tmp_path, monkeypatch):
    monkeypatch.setattr("reelvault.fetch_apify.time.sleep", lambda *_a, **_k: None)
    con = _seed(tmp_path)
    row = _row(con, title="My saved reel")
    items = [{
        "shortCode": "DY4ZdXVP1qa",
        "caption": "Should not replace",
        "videoUrl": "https://cdn.example/v.mp4",
    }]
    fetch_batch(con, [row], "tok", dry_run=False, session=FakeSession(items=items))
    fresh = con.execute("select title from items where id='id1'").fetchone()
    assert fresh["title"] == "My saved reel"


def test_thumbnail_only_if_empty(tmp_path, monkeypatch):
    monkeypatch.setattr("reelvault.fetch_apify.time.sleep", lambda *_a, **_k: None)
    con = _seed(tmp_path)
    row = _row(con, thumbnail="https://already/here.jpg")
    items = [{
        "shortCode": "DY4ZdXVP1qa",
        "caption": "x",
        "displayUrl": "https://cdn.example/new.jpg",
        "videoUrl": "https://cdn.example/v.mp4",
    }]
    fetch_batch(con, [row], "tok", dry_run=False, session=FakeSession(items=items))
    fresh = con.execute("select thumbnail from items where id='id1'").fetchone()
    assert fresh["thumbnail"] == "https://already/here.jpg"


def test_missing_item_failed_retryable(tmp_path, monkeypatch):
    monkeypatch.setattr("reelvault.fetch_apify.time.sleep", lambda *_a, **_k: None)
    con = _seed(tmp_path)
    row = _row(con)
    _out, counts = fetch_batch(con, [row], "tok", dry_run=False, session=FakeSession(items=[]))
    fresh = con.execute("select * from items where id='id1'").fetchone()
    assert fresh["content_status"] == "failed"
    assert fresh["content_error"] == "apify: not returned"
    assert counts["failed"] == 1


def test_permanent_error_unavailable(tmp_path, monkeypatch):
    monkeypatch.setattr("reelvault.fetch_apify.time.sleep", lambda *_a, **_k: None)
    con = _seed(tmp_path)
    row = _row(con)
    items = [{"shortCode": "DY4ZdXVP1qa", "error": "Media not found", "errorDescription": "Post deleted"}]
    _out, counts = fetch_batch(con, [row], "tok", dry_run=False, session=FakeSession(items=items))
    fresh = con.execute("select * from items where id='id1'").fetchone()
    assert fresh["content_status"] == "unavailable"
    assert counts["unavailable"] == 1


def test_transient_error_failed(tmp_path, monkeypatch):
    monkeypatch.setattr("reelvault.fetch_apify.time.sleep", lambda *_a, **_k: None)
    con = _seed(tmp_path)
    row = _row(con)
    items = [{"shortCode": "DY4ZdXVP1qa", "error": "rate_limit", "errorDescription": "try again later"}]
    _out, counts = fetch_batch(con, [row], "tok", dry_run=False, session=FakeSession(items=items))
    fresh = con.execute("select * from items where id='id1'").fetchone()
    assert fresh["content_status"] == "failed"
    assert fresh["content_error"].startswith("apify:")
    assert counts["failed"] == 1


def test_guardrail_refusal_no_post(tmp_path):
    con = _seed(tmp_path)
    row = _row(con)
    # 4.497 + (1×0.003+0.001) = 4.501 > 4.50
    sess = FakeSession(limits_used=4.497, refuse_post=True)
    with pytest.raises(GuardrailError):
        fetch_batch(con, [row], "tok", dry_run=False, session=sess)
    assert sess.posts == []
