"""DB migration, queue, save, stats — temp DB only, no network."""
from __future__ import annotations

import sqlite3
from pathlib import Path

from reelvault import db


ORIGINAL_DDL = """
create table items (
  id text primary key,
  url text not null unique,
  source text not null,
  title text not null,
  author text,
  thumbnail text,
  summary text,
  category text not null default 'uncategorized',
  tags text not null default '[]',
  notes text,
  origin text not null default 'manual',
  created_at text not null,
  added_at text not null default '',
  media_file text,
  video text,
  video_file text
);
"""


def _fresh(tmp_path: Path) -> sqlite3.Connection:
    path = tmp_path / "t.db"
    con = sqlite3.connect(path)
    con.row_factory = sqlite3.Row
    con.executescript(ORIGINAL_DDL)
    con.commit()
    db.ensure_schema(con)
    db.ensure_schema(con)  # idempotent
    return con


def _insert(con, **kw):
    cols = {
        "id": "a",
        "url": "https://www.instagram.com/reel/AAA/",
        "source": "instagram",
        "title": "t",
        "category": "uncategorized",
        "tags": "[]",
        "origin": "dm_shared",
        "created_at": "2026-01-01T00:00:00Z",
        "added_at": "2026-01-02T00:00:00Z",
    }
    cols.update(kw)
    con.execute(
        f"insert into items ({','.join(cols)}) values ({','.join('?' for _ in cols)})",
        list(cols.values()),
    )
    con.commit()


def test_migration_adds_columns(tmp_path):
    con = _fresh(tmp_path)
    names = {r["name"] for r in con.execute("pragma table_info(items)")}
    for col in (
        "caption", "transcript", "ocr_text", "entities", "actions",
        "content_status", "content_error", "keyframe_file", "duration_s",
        "music", "fetcher",
    ):
        assert col in names
    tables = {r[0] for r in con.execute(
        "select name from sqlite_master where type='table'"
    )}
    assert "quota_ledger" in tables


def test_queue_ordering_and_retry(tmp_path):
    con = _fresh(tmp_path)
    _insert(con, id="p", url="https://instagram.com/reel/P/", content_status="pending",
            added_at="2026-01-03T00:00:00Z")
    _insert(con, id="f", url="https://instagram.com/reel/F/", content_status="fetched",
            added_at="2026-01-01T00:00:00Z")
    _insert(con, id="x", url="https://instagram.com/reel/X/", content_status="failed",
            added_at="2026-01-04T00:00:00Z")
    _insert(con, id="u", url="https://instagram.com/reel/U/", content_status="unavailable",
            added_at="2026-01-05T00:00:00Z")

    q = db.queue(con, None, retry_failed=False)
    assert [r["id"] for r in q] == ["f", "p"]

    q2 = db.queue(con, None, retry_failed=True)
    assert [r["id"] for r in q2] == ["f", "p", "x"]


def test_save_and_stats(tmp_path):
    con = _fresh(tmp_path)
    _insert(con, id="1", url="https://instagram.com/reel/1/")
    db.save(con, "1", caption="hi", content_status="fetched")
    row = con.execute("select * from items where id='1'").fetchone()
    assert row["caption"] == "hi"
    assert row["content_status"] == "fetched"

    s = db.stats(con)
    assert s["total"] == 1
    assert s["by_status"].get("fetched") == 1
    assert s["coverage"]["caption"] == 1
    assert s["free_disk_bytes"] > 0
