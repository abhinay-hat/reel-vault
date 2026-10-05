"""Per-item orchestration: download → frames → OCR → whisper → save."""
from __future__ import annotations

import hashlib
import shutil
import tempfile
from pathlib import Path
from typing import Any, Optional

from reelvault.db import MEDIA_DIR, save
from reelvault.fetch_apify import FetchResult
from reelvault.media import (
    HOOK_TIMES,
    dedupe_frames,
    detect_cuts,
    dhash_bits,
    download,
    extract_frames_at,
    pick_keyframe,
    pick_later_times,
    probe,
)
from reelvault.ocr import merge_frame_texts, read_frame
from reelvault.transcribe import transcribe as whisper_transcribe


def _video_dest(item_id: str) -> Path:
    name = hashlib.md5(item_id.encode()).hexdigest() + ".mp4"
    return MEDIA_DIR / name


def _keyframe_dest(item_id: str) -> Path:
    name = hashlib.md5(item_id.encode()).hexdigest() + "_k.jpg"
    return MEDIA_DIR / name


def process_item(
    con: Any,
    row: Any,
    fetched: Optional[FetchResult],
    *,
    keep_media: bool = False,
    tessdata_dir: Path,
) -> None:
    """Fill transcript/ocr/keyframe; leave status transcribed or failed."""
    item_id = row["id"]
    video_url = (fetched.video_url if fetched else None) or row["video"]
    image_urls = list(fetched.image_urls) if fetched and fetched.image_urls else []

    MEDIA_DIR.mkdir(parents=True, exist_ok=True)

    if video_url:
        _process_video(
            con, row, video_url,
            keep_media=keep_media,
            tessdata_dir=tessdata_dir,
        )
        return

    if image_urls:
        _process_images(con, row, image_urls, tessdata_dir=tessdata_dir)
        return

    # No media — caption alone is a complete result.
    save(con, item_id, content_status="transcribed", content_error=None)


def _process_video(
    con: Any,
    row: Any,
    video_url: str,
    *,
    keep_media: bool,
    tessdata_dir: Path,
) -> None:
    item_id = row["id"]
    dest = _video_dest(item_id)
    video = download(video_url, dest)
    if not video:
        save(con, item_id, content_status="failed", content_error="media download failed")
        return

    save(con, item_id, video_file=video.name)

    try:
        info = probe(video)
        duration = float(info.get("duration") or 0)
    except Exception:  # noqa: BLE001
        duration = float(row["duration_s"] or 0) if row["duration_s"] else 0.0

    cuts = detect_cuts(video, duration) if duration > 0 else []
    later = pick_later_times(cuts, duration) if duration > 0 else []
    times = sorted({*HOOK_TIMES, *later})
    times = [t for t in times if duration <= 0 or t < duration]

    ocr_note: Optional[str] = None
    transcript = ""
    ocr_text = ""
    keyframe_name: Optional[str] = None

    with tempfile.TemporaryDirectory(prefix="rv-frames-") as td:
        tdir = Path(td)
        frames = extract_frames_at(video, times, tdir) if times else []
        texts: list[str] = []
        hashes: list[int] = []
        for _t, path in frames:
            texts.append(read_frame(path, tessdata_dir))
            hashes.append(dhash_bits(path))
        uniq_idx, _rep = dedupe_frames(hashes, texts) if hashes else ([], [])
        uniq_texts = [texts[i] for i in uniq_idx]
        ocr_text = merge_frame_texts(uniq_texts)

        try:
            transcript = whisper_transcribe(video)
        except Exception as e:  # noqa: BLE001
            ocr_note = f"transcription failed: {e}"[:200]
            transcript = ""

        kf_src = pick_keyframe(frames)
        if kf_src and kf_src.exists():
            kf_dest = _keyframe_dest(item_id)
            shutil.copy2(kf_src, kf_dest)
            keyframe_name = kf_dest.name

    patch: dict[str, Any] = {
        "transcript": transcript or None,
        "ocr_text": ocr_text or None,
        "content_status": "transcribed",
        "content_error": ocr_note,
    }
    if keyframe_name:
        patch["keyframe_file"] = keyframe_name
        if not row["media_file"]:
            patch["media_file"] = keyframe_name
    if (not row["duration_s"]) and duration > 0:
        patch["duration_s"] = duration

    if not keep_media:
        try:
            video.unlink(missing_ok=True)
        except OSError:
            pass
        patch["video_file"] = None

    save(con, item_id, **patch)


def _process_images(
    con: Any,
    row: Any,
    image_urls: list[str],
    *,
    tessdata_dir: Path,
) -> None:
    item_id = row["id"]
    with tempfile.TemporaryDirectory(prefix="rv-imgs-") as td:
        tdir = Path(td)
        texts: list[str] = []
        first: Optional[Path] = None
        for i, url in enumerate(image_urls[:10]):
            dest = tdir / f"img_{i:02d}.jpg"
            got = download(url, dest)
            if not got:
                continue
            if first is None:
                first = got
            texts.append(read_frame(got, tessdata_dir))

        if first is None:
            save(
                con, item_id,
                content_status="failed",
                content_error="media download failed",
            )
            return

        ocr_text = merge_frame_texts(texts)
        kf_dest = _keyframe_dest(item_id)
        shutil.copy2(first, kf_dest)
        patch: dict[str, Any] = {
            "ocr_text": ocr_text or None,
            "transcript": None,
            "keyframe_file": kf_dest.name,
            "content_status": "transcribed",
            "content_error": None,
        }
        if not row["media_file"]:
            patch["media_file"] = kf_dest.name
        save(con, item_id, **patch)
