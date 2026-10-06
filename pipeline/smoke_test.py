#!/usr/bin/env python3
"""Synthetic smoke: frames → OCR → whisper on a local test video. No DB."""
from __future__ import annotations

import sys
import tempfile
import time
from pathlib import Path

PIPE = Path(__file__).resolve().parent
sys.path.insert(0, str(PIPE))

from reelvault.media import (  # noqa: E402
    HOOK_TIMES,
    detect_cuts,
    dedupe_frames,
    dhash_bits,
    extract_frames_at,
    pick_later_times,
    probe,
)
from reelvault.ocr import frame_ocr, merge_frame_texts, tesseract_indic  # noqa: E402
from reelvault.transcribe import transcribe  # noqa: E402


def main() -> int:
    video = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/rv_smoke.mp4")
    if not video.exists():
        print(f"missing {video}; build it with the ffmpeg/PIL recipe")
        return 1
    tessdata = PIPE / "tessdata"
    t0 = time.time()
    info = probe(video)
    duration = float(info["duration"])
    cuts = detect_cuts(video, duration)
    times = sorted({*HOOK_TIMES, *pick_later_times(cuts, duration)})
    times = [t for t in times if t < duration]
    with tempfile.TemporaryDirectory() as td:
        frames = extract_frames_at(video, times, Path(td))
        t_frames = time.time()

        vision_texts: list[str] = []
        vision_secs: list[float] = []
        hashes: list[int] = []
        for _t, path in frames:
            s = time.time()
            vision_texts.append(frame_ocr(path))
            vision_secs.append(time.time() - s)
            hashes.append(dhash_bits(path))
        t_vision = time.time()

        uniq_idx, _ = dedupe_frames(hashes, vision_texts) if hashes else ([], [])
        parts: list[str] = []
        tess_secs: list[float] = []
        for i in uniq_idx:
            s = time.time()
            indic = tesseract_indic(frames[i][1], tessdata)
            tess_secs.append(time.time() - s)
            chunk = vision_texts[i]
            if indic:
                chunk = f"{chunk}\n{indic}" if chunk else indic
            parts.append(chunk)
        ocr = merge_frame_texts(parts)
        t_tess = time.time()

        transcript = transcribe(video)
        t_tr = time.time()

    print(f"frames: {len(frames)}  ({t_frames - t0:.1f}s)")
    if vision_secs:
        print(
            f"vision: total {sum(vision_secs):.1f}s  "
            f"per-frame {[round(x, 2) for x in vision_secs]}"
        )
    if tess_secs:
        print(
            f"tesseract (unique {len(uniq_idx)}): total {sum(tess_secs):.1f}s  "
            f"per-frame {[round(x, 2) for x in tess_secs]}"
        )
    print(f"OCR text:\n{ocr}")
    print(f"transcript ({t_tr - t_tess:.1f}s):\n{transcript}")
    print(f"item total: {t_tr - t0:.1f}s")
    ok_ocr = "TOP 3 AI TOOLS" in ocr.upper() or "TOP 3" in ocr.upper()
    ok_tr = "smoke test" in transcript.lower()
    print(f"ocr_ok={ok_ocr} transcript_ok={ok_tr}")
    return 0 if ok_ocr and ok_tr else 2


if __name__ == "__main__":
    raise SystemExit(main())
