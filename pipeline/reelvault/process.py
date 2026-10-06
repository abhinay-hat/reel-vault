"""Per-item orchestration: download → frames → OCR → whisper → save."""
from __future__ import annotations

import hashlib
import shutil
import tempfile
import time
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
from reelvault.ocr import frame_ocr, check_vision, merge_frame_texts, tesseract_indic
from reelvault.transcribe import transcribe as whisper_transcribe


def _video_dest(item_id: str) -> Path:
    name = hashlib.md5(item_id.encode()).hexdigest() + ".mp4"
    return MEDIA_DIR / name


def _keyframe_dest(item_id: str) -> Path:
    name = hashlib.md5(item_id.encode()).hexdigest() + "_k.jpg"
    return MEDIA_DIR / name


def delete_video_file(item_id: str) -> None:
    """Remove downloaded mp4 if present. Used after process crashes."""
    path = _video_dest(item_id)
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass


def process_item(
    con: Any,
    row: Any,
    fetched: Optional[FetchResult],
    *,
    keep_media: bool = False,
    tessdata_dir: Path,
    caption_only_ok: bool = False,
) -> None:
    """Fill transcript/ocr/keyframe; leave status transcribed or failed.

    caption_only_ok: sidecar path may finish on caption alone. Apify resume
    without a FetchResult must not mark image posts transcribed with empty OCR.
    """
    item_id = row["id"]
    video_url = (fetched.video_url if fetched else None) or row["video"]
    image_urls = list(fetched.image_urls) if fetched and fetched.image_urls else []

    MEDIA_DIR.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    kind = "video" if video_url else ("image" if image_urls else "caption")

    if video_url:
        timings = _process_video(
            con, row, video_url,
            keep_media=keep_media,
            tessdata_dir=tessdata_dir,
        )
        _print_timing(item_id, kind, t0, timings, con)
        return

    if image_urls:
        timings = _process_images(con, row, image_urls, tessdata_dir=tessdata_dir)
        _print_timing(item_id, kind, t0, timings, con)
        return

    if caption_only_ok:
        save(con, item_id, content_status="transcribed", content_error=None)
        _print_timing(item_id, kind, t0, {}, con)
        return

    # Apify resume without fresh FetchResult and no video URL — do not bury
    # image posts as transcribed-with-nothing.
    save(
        con, item_id,
        content_status="failed",
        content_error="no media; re-fetch required",
    )


def _print_timing(
    item_id: str,
    kind: str,
    t0: float,
    timings: dict[str, float],
    con: Any,
) -> None:
    total = time.time() - t0
    row = con.execute(
        "select ocr_text, transcript, content_status from items where id = ?",
        (item_id,),
    ).fetchone()
    if not row or row["content_status"] != "transcribed":
        return
    ocr_n = len(row["ocr_text"] or "")
    tr_n = len(row["transcript"] or "")
    parts = []
    for key in ("frames", "vision", "tesseract", "whisper"):
        if key in timings:
            parts.append(f"{key} {timings[key]:.0f}s")
    detail = ", ".join(parts)
    extra = f" ({detail})" if detail else ""
    print(
        f"  ✓ {item_id[:8]} {kind} {total:.0f}s{extra} "
        f"ocr {ocr_n}ch transcript {tr_n}ch"
    )


def _process_video(
    con: Any,
    row: Any,
    video_url: str,
    *,
    keep_media: bool,
    tessdata_dir: Path,
) -> dict[str, float]:
    item_id = row["id"]
    dest = _video_dest(item_id)
    video = download(video_url, dest)
    if not video:
        save(con, item_id, content_status="failed", content_error="media download failed")
        return {}

    save(con, item_id, video_file=video.name)
    timings: dict[str, float] = {}

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
        t_frames = time.time()
        frames = extract_frames_at(video, times, tdir) if times else []
        timings["frames"] = time.time() - t_frames

        # Vision on every sampled frame, then dedupe, then Indic on uniques only.
        vision_texts: list[str] = []
        hashes: list[int] = []
        t_vis = time.time()
        for _t, path in frames:
            vision_texts.append(frame_ocr(path))
            hashes.append(dhash_bits(path))
        timings["vision"] = time.time() - t_vis
        check_vision(vision_texts)

        uniq_idx, _rep = dedupe_frames(hashes, vision_texts) if hashes else ([], [])
        merged_parts: list[str] = []
        t_tess = time.time()
        for i in uniq_idx:
            path = frames[i][1]
            parts = [vision_texts[i]]
            indic = tesseract_indic(path, tessdata_dir)
            if indic:
                parts.append(indic)
            merged_parts.append("\n".join(p for p in parts if p))
        timings["tesseract"] = time.time() - t_tess
        ocr_text = merge_frame_texts(merged_parts)

        try:
            t_wh = time.time()
            transcript = whisper_transcribe(video)
            timings["whisper"] = time.time() - t_wh
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
    return timings


def _process_images(
    con: Any,
    row: Any,
    image_urls: list[str],
    *,
    tessdata_dir: Path,
) -> dict[str, float]:
    item_id = row["id"]
    timings: dict[str, float] = {}
    with tempfile.TemporaryDirectory(prefix="rv-imgs-") as td:
        tdir = Path(td)
        paths: list[Path] = []
        first: Optional[Path] = None
        for i, url in enumerate(image_urls[:10]):
            dest = tdir / f"img_{i:02d}.jpg"
            got = download(url, dest)
            if not got:
                continue
            if first is None:
                first = got
            paths.append(got)

        if first is None:
            save(
                con, item_id,
                content_status="failed",
                content_error="media download failed",
            )
            return {}

        vision_texts: list[str] = []
        hashes: list[int] = []
        t_vis = time.time()
        for p in paths:
            vision_texts.append(frame_ocr(p))
            hashes.append(dhash_bits(p))
        timings["vision"] = time.time() - t_vis
        check_vision(vision_texts)

        uniq_idx, _ = dedupe_frames(hashes, vision_texts) if hashes else ([], [])
        merged_parts: list[str] = []
        t_tess = time.time()
        for i in uniq_idx:
            parts = [vision_texts[i]]
            indic = tesseract_indic(paths[i], tessdata_dir)
            if indic:
                parts.append(indic)
            merged_parts.append("\n".join(p for p in parts if p))
        timings["tesseract"] = time.time() - t_tess

        ocr_text = merge_frame_texts(merged_parts)
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
    return timings
