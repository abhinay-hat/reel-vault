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
    extract_frames_at,
    pick_later_times,
    probe,
)
from reelvault.ocr import merge_frame_texts, read_frame  # noqa: E402
from reelvault.transcribe import transcribe  # noqa: E402


def main() -> int:
    video = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/rv_smoke.mp4")
    if not video.exists():
        print(f"missing {video}; build it with the ffmpeg recipe in the phase1 prompt")
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
        texts = [read_frame(p, tessdata) for _t, p in frames]
        ocr = merge_frame_texts(texts)
        t_ocr = time.time()
        transcript = transcribe(video)
        t_tr = time.time()
    print(f"frames: {len(frames)}  ({t_frames - t0:.1f}s)")
    print(f"OCR ({t_ocr - t_frames:.1f}s):\n{ocr}")
    print(f"transcript ({t_tr - t_ocr:.1f}s):\n{transcript}")
    ok_ocr = "TOP 3 AI TOOLS" in ocr.upper() or "TOP 3" in ocr.upper()
    ok_tr = "smoke test" in transcript.lower()
    print(f"ocr_ok={ok_ocr} transcript_ok={ok_tr}")
    return 0 if ok_ocr and ok_tr else 2


if __name__ == "__main__":
    raise SystemExit(main())
