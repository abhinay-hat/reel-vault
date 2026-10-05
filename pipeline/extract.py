#!/usr/bin/env python3
"""
Reel Vault — content extraction pipeline.

Turns a saved Instagram link into text you can actually search and reason over.

A reel keeps what it is teaching in three separate places, and a link carries
none of them:

  caption     the poster's own words          -> re-fetched from the sidecar
  transcript  what is said out loud           -> Whisper, locally, free
  ocr_text    text burned onto the video      -> keyframes read by a vision model

DM-shared reels are the reason all three are needed. Instagram's share payload
is just a URL, so 386 of these items landed in the vault titled "Shared by
<user id>" with nothing inside them. Until this script runs, the vault is a list
of links; after it runs, it is a knowledge base.

Design constraints, in order of importance:

1. Do not get the account banned. Every Instagram call goes through the sidecar,
   which paces itself and enters a multi-hour cooldown the moment Instagram
   pushes back. This script's job is to respect that, not to work around it.
2. Be resumable. Extraction takes hours and will be interrupted. Every item's
   progress is committed as it completes, so a restart resumes rather than
   repeats. Ctrl-C is a supported way to stop.
3. Never redo expensive work. A transcript costs minutes of compute; a caption
   costs rate limit. Both are skipped if already present.

Usage:
    python3 pipeline/extract.py                 # run until the queue is empty
    python3 pipeline/extract.py --limit 20      # stop after 20 items
    python3 pipeline/extract.py --captions-only # skip video download/transcribe
    python3 pipeline/extract.py --stats         # show coverage and exit

Requirements:
    pip install -r pipeline/requirements.txt
    ffmpeg on PATH   (brew install ffmpeg)
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import signal
import sqlite3
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Optional

import requests

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = Path(os.environ.get("REEL_VAULT_DB", ROOT / "data" / "reel-vault.db"))
MEDIA_DIR = ROOT / "data" / "media"
BRIDGE_URL = os.environ.get("IG_BRIDGE_URL", "http://127.0.0.1:8765")
ANTHROPIC_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
VISION_MODEL = os.environ.get("REEL_VAULT_VISION_MODEL", "claude-haiku-4-5-20251001")
WHISPER_MODEL = os.environ.get("REEL_VAULT_WHISPER_MODEL", "small")
# Frames sampled per reel for on-screen text. Reels are short and text-heavy
# slides linger, so a handful of evenly spaced frames catches nearly all of it
# while keeping the vision call to one request.
FRAME_COUNT = int(os.environ.get("REEL_VAULT_FRAMES", "4"))

SHORTCODE_RE = re.compile(r"instagram\.com/(?:reel|reels|p|tv)/([A-Za-z0-9_-]+)")

_stop = False


def _handle_sigint(_sig: Any, _frm: Any) -> None:
    """Finish the item in flight, then stop. Killing mid-write is how DBs rot."""
    global _stop
    if _stop:
        print("\n  forced exit")
        sys.exit(1)
    _stop = True
    print("\n  stopping after this item... (Ctrl-C again to force)")


signal.signal(signal.SIGINT, _handle_sigint)


# ----------------------------- db -----------------------------

def connect() -> sqlite3.Connection:
    if not DB_PATH.exists():
        sys.exit(f"No vault at {DB_PATH}. Start the app once to create it.")
    con = sqlite3.connect(DB_PATH, timeout=30)
    con.row_factory = sqlite3.Row
    # The Next.js app holds this same file open. WAL lets both read while this
    # script writes; without it, a running dev server turns every write into a
    # "database is locked" crash.
    con.execute("pragma journal_mode=WAL")
    con.execute("pragma busy_timeout=30000")
    _ensure_columns(con)
    return con


def _ensure_columns(con: sqlite3.Connection) -> None:
    """Additive migration, mirroring src/lib/db.ts.

    This script can run before the app has ever started, so it cannot assume the
    TypeScript migration has been applied. Both are idempotent and produce the
    same shape, so whichever runs first wins and the other is a no-op.
    """
    have = {r["name"] for r in con.execute("pragma table_info(items)")}
    wanted = {
        "caption": "text",
        "transcript": "text",
        "ocr_text": "text",
        "entities": "text not null default '[]'",
        "actions": "text not null default '[]'",
        "content_status": "text not null default 'pending'",
        "content_error": "text",
    }
    for col, decl in wanted.items():
        if col not in have:
            con.execute(f"alter table items add column {col} {decl}")
    con.commit()


def queue(con: sqlite3.Connection, limit: Optional[int]) -> list[sqlite3.Row]:
    """Items still owed work.

    'unavailable' is excluded deliberately: a deleted reel will never resolve,
    and retrying it spends rate limit that a live reel needs.
    """
    sql = """
        select * from items
        where content_status in ('pending','fetched','failed')
        order by case content_status
                   when 'fetched' then 0
                   when 'pending' then 1
                   else 2
                 end,
                 added_at desc
    """
    if limit:
        sql += f" limit {int(limit)}"
    return list(con.execute(sql))


def save(con: sqlite3.Connection, item_id: str, **fields: Any) -> None:
    if not fields:
        return
    sets = ", ".join(f"{k} = ?" for k in fields)
    con.execute(f"update items set {sets} where id = ?", (*fields.values(), item_id))
    con.commit()


# ----------------------------- step 1: caption -----------------------------

def shortcode(url: str) -> Optional[str]:
    m = SHORTCODE_RE.search(url or "")
    return m.group(1) if m else None


def fetch_caption(con: sqlite3.Connection, item: sqlite3.Row) -> str:
    """Ask the sidecar for this reel's caption and media URLs.

    Returns the next content_status. The sidecar owns all pacing decisions; this
    function's only job is to obey what it says, including sleeping out a
    cooldown that may be hours long.
    """
    code = shortcode(item["url"])
    if not code:
        save(con, item["id"], content_status="unavailable",
             content_error="no shortcode in URL")
        return "unavailable"

    while not _stop:
        try:
            r = requests.get(f"{BRIDGE_URL}/media/{code}", timeout=90)
            data = r.json()
        except requests.RequestException as e:
            save(con, item["id"], content_status="failed", content_error=f"bridge unreachable: {e}")
            print(f"    bridge unreachable ({e}) — is ig-bridge running?")
            return "failed"

        err = data.get("error")
        if err == "too_soon":
            wait = int(data.get("retry_in_s", 25)) + 1
            time.sleep(wait)
            continue
        if err == "cooldown":
            wait = int(data.get("retry_in_s", 3600))
            # Instagram asked for hours, not seconds. Waiting it out beats
            # losing the account, and the queue is resumable anyway.
            print(f"    cooldown for {wait//60} min ({data.get('reason')}). Stopping;"
                  f" re-run this script later to resume.")
            return "cooldown"
        if err == "login_required":
            print("    sidecar is not logged in — open /connect and link the account.")
            return "cooldown"
        if err == "unavailable":
            save(con, item["id"], content_status="unavailable",
                 content_error=data.get("detail", "media unavailable"))
            return "unavailable"
        if err:
            save(con, item["id"], content_status="failed",
                 content_error=f"{err}: {data.get('detail','')}"[:500])
            return "failed"

        caption = (data.get("caption_text") or "").strip()
        patch: dict[str, Any] = {"content_status": "fetched", "content_error": None}
        if caption:
            patch["caption"] = caption
        if data.get("video_url"):
            patch["video"] = data["video_url"]
        if data.get("thumbnail_url") and not item["thumbnail"]:
            patch["thumbnail"] = data["thumbnail_url"]
        if data.get("author"):
            patch["author"] = data["author"]
        # "Shared by 7456093337" is a placeholder, not a title. The caption's
        # first line is what a person would actually call this reel.
        if caption and (not item["title"] or item["title"].startswith("Shared by")):
            patch["title"] = caption.splitlines()[0][:120]
        save(con, item["id"], **patch)
        return "fetched"

    return "stopped"


# ----------------------------- step 2: video -----------------------------

def download_video(url: str, item_id: str) -> Optional[Path]:
    """Pull the video onto this machine.

    Instagram's CDN URLs are signed and expire within weeks — the vault already
    lost its first 198 thumbnails that way. Bytes on disk are the only copy that
    survives.
    """
    name = hashlib.md5(item_id.encode()).hexdigest() + ".mp4"
    dest = MEDIA_DIR / name
    if dest.exists() and dest.stat().st_size > 1000:
        return dest
    MEDIA_DIR.mkdir(parents=True, exist_ok=True)
    try:
        with requests.get(url, timeout=120, stream=True) as r:
            r.raise_for_status()
            tmp = dest.with_suffix(".part")
            with open(tmp, "wb") as f:
                for chunk in r.iter_content(1 << 16):
                    f.write(chunk)
            tmp.rename(dest)
        return dest
    except Exception as e:  # noqa: BLE001
        print(f"    video download failed: {e}")
        return None


def transcribe(video: Path) -> str:
    """Speech to text, locally. No audio ever leaves the machine."""
    from faster_whisper import WhisperModel

    global _whisper
    if "_whisper" not in globals() or _whisper is None:
        print(f"    loading whisper '{WHISPER_MODEL}' (first run downloads it)...")
        # int8 on CPU is the difference between this finishing overnight and
        # not finishing. Accuracy loss on clear speech is negligible.
        _whisper = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8")

    segments, info = _whisper.transcribe(str(video), vad_filter=True)
    text = " ".join(s.text.strip() for s in segments).strip()
    # A reel with only music transcribes to noise or nothing. Better to store
    # nothing than to pollute search with hallucinated lyrics.
    if len(text) < 15:
        return ""
    return f"[{info.language}] {text}" if info.language and info.language != "en" else text


def keyframes(video: Path, count: int) -> list[bytes]:
    """Sample evenly spaced frames as JPEGs, via ffmpeg."""
    frames: list[bytes] = []
    try:
        probe = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", str(video)],
            capture_output=True, text=True, timeout=30,
        )
        duration = float(probe.stdout.strip() or 0)
    except Exception:  # noqa: BLE001
        duration = 0.0
    if duration <= 0:
        return frames

    with tempfile.TemporaryDirectory() as td:
        for i in range(count):
            # Offset into each slice rather than sampling at 0s: the first frame
            # of a reel is usually a cover image, not content.
            at = duration * (i + 0.5) / count
            out = Path(td) / f"f{i}.jpg"
            try:
                subprocess.run(
                    ["ffmpeg", "-loglevel", "error", "-ss", f"{at:.2f}", "-i", str(video),
                     "-frames:v", "1", "-vf", "scale=640:-1", "-q:v", "5", "-y", str(out)],
                    capture_output=True, timeout=60,
                )
                if out.exists():
                    frames.append(out.read_bytes())
            except Exception:  # noqa: BLE001
                continue
    return frames


def read_frames(frames: list[bytes]) -> str:
    """Read text off the frames with a vision model.

    Tesseract is the obvious choice and the wrong one here: reel text is
    stylised, coloured, animated, and laid over moving video, which is close to
    the worst case for classical OCR. A vision model reads it the way a person
    would, and also skips the watermarks and UI furniture that OCR happily
    transcribes as garbage.
    """
    if not frames or not ANTHROPIC_KEY:
        return ""
    content: list[dict[str, Any]] = [{
        "type": "text",
        "text": ("These are frames from one Instagram reel. Transcribe ONLY the text "
                 "visible on screen, in reading order, deduplicated across frames. "
                 "Ignore usernames, watermarks, and Instagram UI. "
                 "If there is no meaningful on-screen text, reply with exactly: NONE"),
    }]
    for f in frames:
        content.append({
            "type": "image",
            "source": {"type": "base64", "media_type": "image/jpeg",
                       "data": base64.b64encode(f).decode()},
        })
    try:
        r = requests.post(
            "https://api.anthropic.com/v1/messages",
            headers={"x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01",
                     "content-type": "application/json"},
            json={"model": VISION_MODEL, "max_tokens": 1000,
                  "messages": [{"role": "user", "content": content}]},
            timeout=120,
        )
        r.raise_for_status()
        text = "".join(b.get("text", "") for b in r.json().get("content", [])).strip()
        return "" if text.upper().startswith("NONE") else text
    except Exception as e:  # noqa: BLE001
        print(f"    frame reading failed: {e}")
        return ""


def process_video(con: sqlite3.Connection, item: sqlite3.Row) -> None:
    """Download, transcribe, and read the frames of one reel."""
    row = con.execute("select video, video_file from items where id = ?", (item["id"],)).fetchone()
    url = row["video"]
    if not url:
        # Not every saved item is a video — a shared article has no clip, and
        # its caption is all there is. That is a complete result, not a failure.
        save(con, item["id"], content_status="transcribed")
        return

    video = download_video(url, item["id"])
    if not video:
        save(con, item["id"], content_status="failed", content_error="video download failed")
        return
    save(con, item["id"], video_file=video.name)

    patch: dict[str, Any] = {"content_status": "transcribed", "content_error": None}
    try:
        text = transcribe(video)
        patch["transcript"] = text or None
        if text:
            print(f"    transcript: {len(text)} chars")
    except Exception as e:  # noqa: BLE001
        print(f"    transcribe failed: {e}")
        patch["content_error"] = f"transcribe: {e}"[:300]

    try:
        seen = read_frames(keyframes(video, FRAME_COUNT))
        patch["ocr_text"] = seen or None
        if seen:
            print(f"    on-screen text: {len(seen)} chars")
    except Exception as e:  # noqa: BLE001
        print(f"    frames failed: {e}")

    save(con, item["id"], **patch)


# ----------------------------- main -----------------------------

def stats(con: sqlite3.Connection) -> None:
    r = con.execute("""
        select count(*) total,
               sum(coalesce(caption,'')    != '') captions,
               sum(coalesce(transcript,'') != '') transcripts,
               sum(coalesce(ocr_text,'')   != '') onscreen,
               sum(coalesce(summary,'')    != '') summaries,
               sum(content_status = 'unavailable') unavailable,
               sum(content_status = 'failed')      failed
        from items
    """).fetchone()
    total = r["total"] or 1
    print(f"\n  vault: {r['total']} items")
    for label, key in [("caption", "captions"), ("transcript", "transcripts"),
                       ("on-screen text", "onscreen"), ("summary", "summaries")]:
        n = r[key] or 0
        print(f"    {label:<16} {n:>4} / {r['total']}  ({100*n//total}%)")
    print(f"    unavailable      {r['unavailable'] or 0:>4}")
    print(f"    failed           {r['failed'] or 0:>4}\n")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, help="stop after N items")
    ap.add_argument("--captions-only", action="store_true",
                    help="skip video download and transcription")
    ap.add_argument("--stats", action="store_true", help="show coverage and exit")
    args = ap.parse_args()

    con = connect()
    if args.stats:
        stats(con)
        return

    if not ANTHROPIC_KEY:
        print("  note: ANTHROPIC_API_KEY unset — on-screen text will be skipped.")

    items = queue(con, args.limit)
    if not items:
        print("  nothing to extract. Everything is done.")
        stats(con)
        return

    print(f"  {len(items)} items queued.")
    print(f"  Instagram lookups are paced ~25s apart on purpose"
          f" (~{len(items) * 25 // 60} min minimum for captions alone).\n")

    done = 0
    for i, item in enumerate(items, 1):
        if _stop:
            break
        title = (item["title"] or item["url"])[:58]
        print(f"  [{i}/{len(items)}] {title}")

        status = item["content_status"]
        if not item["caption"] and status in ("pending", "failed"):
            status = fetch_caption(con, item)
            if status == "cooldown":
                break
            if status in ("unavailable", "failed"):
                print(f"    -> {status}")
                continue
            print("    caption fetched")

        if not args.captions_only and not item["transcript"]:
            process_video(con, item)

        done += 1

    print(f"\n  processed {done} item(s).")
    stats(con)
    print("  Next: run the enricher to turn this text into summaries and entities:")
    print("    curl -X POST http://localhost:3210/api/enrich-pending\n")


if __name__ == "__main__":
    main()
