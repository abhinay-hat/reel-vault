#!/usr/bin/env python3
"""
Reel Vault — content extraction CLI (Phase 1 zero-spend offline pipeline).

Default path: Apify Free (caption + media URL) → local ffmpeg / Vision /
Tesseract / mlx-whisper. Sidecar is opt-in only (--fetcher sidecar).

Usage:
    python pipeline/extract.py --stats
    python pipeline/extract.py --limit 10            # dry run
    python pipeline/extract.py --limit 10 --run
    python pipeline/extract.py --run --fetcher sidecar
"""
from __future__ import annotations

import argparse
import math
import os
import signal
import sys
from pathlib import Path
from typing import Any, Optional

ROOT = Path(__file__).resolve().parent.parent
PIPE = Path(__file__).resolve().parent
TESSDATA = PIPE / "tessdata"
BACKUP = ROOT / "data" / "reel-vault.db.bak-phase1"

_stop = False


def _handle_sigint(_sig: Any, _frm: Any) -> None:
    global _stop
    if _stop:
        print("\n  forced exit")
        sys.exit(130)
    _stop = True
    print("\n  finishing current item, then stopping (Ctrl-C again to force)…")


def load_env_local() -> None:
    """Simple KEY=VALUE loader for .env.local. Never prints values."""
    path = ROOT / ".env.local"
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        key = key.strip()
        val = val.strip().strip("'").strip('"')
        if key and key not in os.environ:
            os.environ[key] = val


def _backup_db_once() -> None:
    from reelvault.db import DB_PATH
    import shutil

    if BACKUP.exists() or not DB_PATH.exists():
        return
    BACKUP.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(DB_PATH, BACKUP)
    print(f"  backed up DB → {BACKUP.name}")


def main() -> None:
    load_env_local()
    # Imports after env so tokens / paths are visible.
    from reelvault import db
    from reelvault.db import print_stats, queue, stats
    from reelvault.fetch_apify import FetchError, fetch_batch, normalize_url
    from reelvault.fetch_sidecar import fetch_caption, set_stop as sidecar_stop
    from reelvault.guardrails import (
        GuardrailError,
        assert_free_plan,
        can_run_batch,
        check_disk,
        credit_left,
        credit_used,
        estimate_batch_usd,
        fetch_apify_limits,
    )
    from reelvault.process import process_item

    parser = argparse.ArgumentParser(description="Reel Vault content extraction")
    parser.add_argument("--stats", action="store_true", help="show coverage and exit")
    parser.add_argument("--limit", type=int, default=None, help="max items this run")
    parser.add_argument("--run", action="store_true", help="actually fetch/process (default: dry run)")
    parser.add_argument(
        "--fetcher", choices=("apify", "sidecar"), default="apify",
        help="caption/media source (default apify)",
    )
    parser.add_argument("--retry-failed", action="store_true")
    parser.add_argument("--keep-media", action="store_true")
    parser.add_argument("--batch", type=int, default=15, help="Apify batch size")
    args = parser.parse_args()

    signal.signal(signal.SIGINT, _handle_sigint)

    con = db.connect()
    if args.stats:
        print_stats(con)
        return

    rows = queue(con, args.limit, retry_failed=args.retry_failed)
    batch_size = max(1, args.batch)
    n_batches = math.ceil(len(rows) / batch_size) if rows else 0
    est = estimate_batch_usd(min(batch_size, len(rows))) * max(n_batches, 0) if rows else 0.0

    token = (os.environ.get("APIFY_TOKEN") or "").strip()
    disk_ok, free_bytes = check_disk(db.MEDIA_DIR if db.MEDIA_DIR.exists() else db.DB_PATH.parent)

    print(f"queued: {len(rows)}  batches≈{n_batches}  est credit≈${est:.4f}")
    print(f"free disk: {free_bytes / (1024**3):.1f} GB  ({'ok' if disk_ok else 'LOW'})")

    if args.fetcher == "apify":
        if token:
            try:
                limits = fetch_apify_limits(token)
                assert_free_plan(limits)
                used = credit_used(limits)
                left = credit_left(limits)
                print(f"apify credit used=${used:.4f} left≈${left:.4f} (stop at $4.50)")
            except GuardrailError as e:
                print(f"guardrail: {e}")
                if args.run:
                    sys.exit(1)
            except Exception as e:  # noqa: BLE001
                print(f"apify limits unavailable: {e}")
        else:
            print(
                "No APIFY_TOKEN. Add APIFY_TOKEN=... to .env.local "
                "(free Apify account, no card attached)."
            )
            if not args.run:
                return
            if args.fetcher == "apify":
                sys.exit(1)

    if not args.run:
        print("dry run — no Apify actor runs, no downloads. Pass --run to execute.")
        return

    _backup_db_once()
    keep_media = args.keep_media or os.environ.get("KEEP_MEDIA", "").lower() in (
        "1", "true", "yes",
    )
    tessdata = TESSDATA
    if not tessdata.exists():
        print(f"missing {tessdata}; run pipeline/setup.sh first")
        sys.exit(1)

    if args.fetcher == "sidecar":
        _run_sidecar(con, rows, keep_media, tessdata)
    else:
        _run_apify(con, rows, token, batch_size, keep_media, tessdata)

    print()
    print_stats(con)
    print()
    print("Next: open pipeline/start-llm.command; npm run dev; scripts/enrich-all.sh")


def _safe_process(
    con: Any,
    row: Any,
    fetched: Any,
    *,
    keep_media: bool,
    tessdata: Path,
    caption_only_ok: bool = False,
) -> None:
    """Run process_item; one bad reel must not kill an unattended run."""
    from reelvault.db import save
    from reelvault.process import delete_video_file, process_item

    try:
        process_item(
            con, row, fetched,
            keep_media=keep_media,
            tessdata_dir=tessdata,
            caption_only_ok=caption_only_ok,
        )
    except KeyboardInterrupt:
        raise
    except Exception as e:  # noqa: BLE001
        msg = f"process: {type(e).__name__}: {e}"[:300]
        save(con, row["id"], content_status="failed", content_error=msg)
        if not keep_media:
            delete_video_file(row["id"])
            save(con, row["id"], video_file=None)
        print(f"  ! {row['id'][:8]} {msg}")


def _run_sidecar(con: Any, rows: list, keep_media: bool, tessdata: Path) -> None:
    from reelvault.fetch_sidecar import fetch_caption, set_stop as sidecar_stop

    for row in rows:
        if _stop:
            break
        print(f"→ {row['id'][:8]}  { (row['title'] or '')[:60]}")
        status = fetch_caption(con, row)
        if status in ("cooldown", "stopped"):
            break
        if status != "fetched":
            continue
        fresh = con.execute("select * from items where id = ?", (row["id"],)).fetchone()
        _safe_process(
            con, fresh, None,
            keep_media=keep_media,
            tessdata=tessdata,
            caption_only_ok=True,
        )
        sidecar_stop(_stop)


def _run_apify(
    con: Any,
    rows: list,
    token: str,
    batch_size: int,
    keep_media: bool,
    tessdata: Path,
) -> None:
    from reelvault.db import MEDIA_DIR, DB_PATH
    from reelvault.fetch_apify import FetchError, fetch_batch, normalize_url
    from reelvault.guardrails import (
        GuardrailError,
        assert_free_plan,
        can_run_batch,
        check_disk,
        fetch_apify_limits,
    )

    try:
        limits = fetch_apify_limits(token)
        assert_free_plan(limits)
    except GuardrailError as e:
        print(f"guardrail: {e}")
        sys.exit(1)

    # Re-fetch interrupted `fetched` rows with pending — CDN URLs expire and
    # image posts have no stored image list without a fresh Apify result.
    already = [r for r in rows if r["content_status"] == "fetched"]
    pending = [r for r in rows if r["content_status"] != "fetched"]
    work = already + pending  # fetched first

    totals = {"fetched": 0, "failed": 0, "unavailable": 0}

    for i in range(0, len(work), batch_size):
        if _stop:
            break
        batch = work[i : i + batch_size]
        ok_disk, free = check_disk(MEDIA_DIR if MEDIA_DIR.exists() else DB_PATH.parent)
        if not ok_disk:
            print(f"disk low ({free / (1024**3):.1f} GB < 3 GB) — stopping")
            break
        try:
            limits = fetch_apify_limits(token)
            ok, reason = can_run_batch(limits, len(batch))
            if not ok:
                print(reason)
                break
            print(f"batch {i // batch_size + 1}: {len(batch)} urls")
            results, counts = fetch_batch(
                con, batch, token, dry_run=False, limits=limits,
            )
            for k in totals:
                totals[k] += counts.get(k, 0)
            print(
                f"  fetch: fetched={counts.get('fetched', 0)} "
                f"failed={counts.get('failed', 0)} "
                f"unavailable={counts.get('unavailable', 0)}"
            )
        except GuardrailError as e:
            print(f"guardrail: {e}")
            break
        except FetchError as e:
            print(f"fetch error: {e}")
            break

        for row in batch:
            if _stop:
                break
            fresh = con.execute("select * from items where id = ?", (row["id"],)).fetchone()
            if fresh["content_status"] != "fetched":
                continue
            norm = normalize_url(row["url"])
            fr = results.get(norm[1]) if norm else None
            print(f"  process {row['id'][:8]}")
            _safe_process(
                con, fresh, fr,
                keep_media=keep_media,
                tessdata=tessdata,
                caption_only_ok=False,
            )

    print(
        f"run totals: fetched={totals['fetched']} "
        f"failed={totals['failed']} unavailable={totals['unavailable']}"
    )


if __name__ == "__main__":
    main()
