"""SQLite access for the extraction pipeline.

Mirrors the additive migrations in src/lib/db.ts so either side can apply them
first. WAL + busy_timeout let the Next.js app keep the same file open.
"""
from __future__ import annotations

import os
import shutil
import sqlite3
import sys
from pathlib import Path
from typing import Any, Optional

ROOT = Path(__file__).resolve().parent.parent.parent
DB_PATH = Path(os.environ.get("REEL_VAULT_DB", ROOT / "data" / "reel-vault.db"))
MEDIA_DIR = Path(os.environ.get("REEL_VAULT_MEDIA", ROOT / "data" / "media"))

# Columns the live DB may still lack (groundwork: only the original 16 exist).
_ITEM_COLUMNS: list[tuple[str, str]] = [
    ("media_file", "text"),
    ("video", "text"),
    ("video_file", "text"),
    ("caption", "text"),
    ("transcript", "text"),
    ("ocr_text", "text"),
    ("entities", "text not null default '[]'"),
    ("actions", "text not null default '[]'"),
    ("content_status", "text not null default 'pending'"),
    ("content_error", "text"),
    ("keyframe_file", "text"),
    ("duration_s", "real"),
    ("music", "text"),
    ("fetcher", "text"),
    ("enrich_attempts", "integer not null default 0"),
]


def connect(db_path: Optional[Path] = None) -> sqlite3.Connection:
    path = Path(db_path) if db_path else DB_PATH
    if not path.exists():
        sys.exit(f"No vault at {path}. Start the app once to create it.")
    con = sqlite3.connect(path, timeout=30)
    con.row_factory = sqlite3.Row
    con.execute("pragma journal_mode=WAL")
    con.execute("pragma busy_timeout=30000")
    ensure_schema(con)
    return con


def ensure_schema(con: sqlite3.Connection) -> None:
    """Additive, idempotent migration. Safe to run twice."""
    have = {r["name"] for r in con.execute("pragma table_info(items)")}
    for col, decl in _ITEM_COLUMNS:
        if col not in have:
            con.execute(f"alter table items add column {col} {decl}")
    con.execute(
        "create index if not exists items_content_status_idx on items(content_status)"
    )
    con.execute(
        """
        create table if not exists quota_ledger (
          id integer primary key autoincrement,
          at text not null,
          provider text not null,
          run_id text,
          items integer not null default 0,
          usd_reported real,
          monthly_usage_after real,
          note text
        )
        """
    )
    con.commit()


def queue(
    con: sqlite3.Connection,
    limit: Optional[int],
    retry_failed: bool = False,
) -> list[sqlite3.Row]:
    """Items still owed work. Default excludes failed so one broken reel can't burn credit."""
    statuses = ("pending", "fetched") + (("failed",) if retry_failed else ())
    placeholders = ",".join("?" * len(statuses))
    sql = f"""
        select * from items
        where content_status in ({placeholders})
        order by case content_status
                   when 'fetched' then 0
                   when 'pending' then 1
                   else 2
                 end,
                 added_at desc
    """
    params: list[Any] = list(statuses)
    if limit is not None:
        sql += " limit ?"
        params.append(int(limit))
    return list(con.execute(sql, params))


def save(con: sqlite3.Connection, item_id: str, **fields: Any) -> None:
    if not fields:
        return
    sets = ", ".join(f"{k} = ?" for k in fields)
    con.execute(f"update items set {sets} where id = ?", (*fields.values(), item_id))
    con.commit()


def append_ledger(
    con: sqlite3.Connection,
    *,
    at: str,
    provider: str,
    run_id: Optional[str],
    items: int,
    usd_reported: Optional[float],
    monthly_usage_after: Optional[float],
    note: Optional[str] = None,
) -> None:
    con.execute(
        """
        insert into quota_ledger
          (at, provider, run_id, items, usd_reported, monthly_usage_after, note)
        values (?, ?, ?, ?, ?, ?, ?)
        """,
        (at, provider, run_id, items, usd_reported, monthly_usage_after, note),
    )
    con.commit()


def stats(con: sqlite3.Connection) -> dict[str, Any]:
    """Coverage + credit + disk for --stats and end-of-run reports."""
    total = con.execute("select count(*) from items").fetchone()[0]
    by_status: dict[str, int] = {}
    for row in con.execute(
        "select content_status, count(*) as n from items group by content_status"
    ):
        by_status[row["content_status"] or "pending"] = row["n"]
    coverage = {
        "caption": con.execute(
            "select count(*) from items where caption is not null and caption != ''"
        ).fetchone()[0],
        "transcript": con.execute(
            "select count(*) from items where transcript is not null and transcript != ''"
        ).fetchone()[0],
        "ocr_text": con.execute(
            "select count(*) from items where ocr_text is not null and ocr_text != ''"
        ).fetchone()[0],
        "summary": con.execute(
            "select count(*) from items where summary is not null and summary != ''"
        ).fetchone()[0],
    }
    no_text = con.execute(
        """
        select count(*) from items
        where content_status = 'transcribed'
          and coalesce(caption,'') = ''
          and coalesce(transcript,'') = ''
          and coalesce(ocr_text,'') = ''
        """
    ).fetchone()[0]
    ledger = con.execute(
        """
        select monthly_usage_after, usd_reported, at
        from quota_ledger
        where provider = 'apify' and monthly_usage_after is not null
        order by id desc limit 1
        """
    ).fetchone()
    credit_used = float(ledger["monthly_usage_after"]) if ledger else None
    data_vol = MEDIA_DIR if MEDIA_DIR.exists() else DB_PATH.parent
    free_bytes = shutil.disk_usage(str(data_vol)).free
    return {
        "total": total,
        "by_status": by_status,
        "coverage": coverage,
        "no_text": no_text,
        "apify_credit_used": credit_used,
        "free_disk_bytes": free_bytes,
    }


def print_stats(con: sqlite3.Connection) -> None:
    s = stats(con)
    print(f"items: {s['total']}")
    for st in ("pending", "fetched", "transcribed", "enriched", "failed", "unavailable"):
        n = s["by_status"].get(st, 0)
        if n:
            print(f"  {st:12s} {n}")
    c = s["coverage"]
    print(
        f"coverage: caption={c['caption']} transcript={c['transcript']} "
        f"ocr={c['ocr_text']} summary={c['summary']}"
    )
    print(f"no text extracted: {s['no_text']}")
    if s["apify_credit_used"] is not None:
        print(f"apify credit used this cycle: ${s['apify_credit_used']:.4f}")
    free_gb = s["free_disk_bytes"] / (1024**3)
    print(f"free disk (data volume): {free_gb:.1f} GB")
