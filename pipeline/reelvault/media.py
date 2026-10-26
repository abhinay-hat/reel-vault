"""Download, probe, scene cuts, keyframes, dhash.

# Ported from reel-watcher (MIT, © 2026 Jacob Bruce): src/reel_watcher/media.py
# Ported from reel-watcher (MIT, © 2026 Jacob Bruce): src/reel_watcher/study.py
"""
from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path
from typing import Optional

import requests

SCENE_THRESHOLD = 0.30
MIN_SHOT_GAP = 0.2
HOOK_TIMES = [0.0, 0.5, 1.0, 1.5, 2.0, 2.5]
LATER_INTERVAL = 3.0
MAX_LATER_FRAMES = 10
DEDUPE_HASH_DIST = 9
MAX_UNIQUE_FRAMES = 9
UA = "Mozilla/5.0"
MAX_DOWNLOAD_BYTES = 250 * 1024 * 1024


def download(url: str, dest: Path) -> Optional[Path]:
    """Stream URL to dest via .part then rename. Returns Path or None."""
    if dest.exists() and dest.stat().st_size > 1000:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    try:
        with requests.get(
            url,
            timeout=120,
            stream=True,
            headers={"User-Agent": UA},
        ) as r:
            r.raise_for_status()
            total = 0
            with open(tmp, "wb") as f:
                for chunk in r.iter_content(1 << 16):
                    if not chunk:
                        continue
                    total += len(chunk)
                    if total > MAX_DOWNLOAD_BYTES:
                        raise ValueError("download_too_large")
                    f.write(chunk)
        tmp.rename(dest)
        return dest
    except Exception:  # noqa: BLE001
        if tmp.exists():
            tmp.unlink(missing_ok=True)
        return None


def _run(cmd: list[str], check: bool = True) -> subprocess.CompletedProcess:
    # Ported from reel-watcher (MIT, © 2026 Jacob Bruce): src/reel_watcher/media.py
    p = subprocess.run(cmd, capture_output=True, text=True)
    if check and p.returncode != 0:
        raise RuntimeError(
            f"{cmd[0]} failed ({p.returncode}): {(p.stderr or p.stdout).strip()[-600:]}"
        )
    return p


def probe(path: str | Path) -> dict:
    # Ported from reel-watcher (MIT, © 2026 Jacob Bruce): src/reel_watcher/media.py
    p = _run(
        [
            "ffprobe", "-v", "error", "-print_format", "json",
            "-show_streams", "-show_format", str(path),
        ]
    )
    j = json.loads(p.stdout)
    v = next((s for s in j.get("streams", []) if s.get("codec_type") == "video"), None)
    if not v:
        raise RuntimeError(f"no video stream in {path}")
    a = any(s.get("codec_type") == "audio" for s in j["streams"])
    fr = v.get("avg_frame_rate") or v.get("r_frame_rate") or "0/1"
    n, _, d = fr.partition("/")
    fps = float(n) / float(d or 1) if float(d or 1) else 0.0
    dur = float(j.get("format", {}).get("duration") or v.get("duration") or 0)
    rot = 0
    for sd in v.get("side_data_list", []) or []:
        if "rotation" in sd:
            rot = abs(int(sd["rotation"])) % 180
    w, h = int(v["width"]), int(v["height"])
    if rot == 90:
        w, h = h, w
    return {
        "duration": round(dur, 3),
        "width": w,
        "height": h,
        "fps": round(fps, 3),
        "has_audio": a,
    }


def detect_cuts(
    video: str | Path,
    duration: float,
    threshold: float = SCENE_THRESHOLD,
) -> list[float]:
    # Ported from reel-watcher (MIT, © 2026 Jacob Bruce): src/reel_watcher/media.py
    p = _run(
        [
            "ffmpeg", "-nostdin", "-i", str(video), "-an", "-vf",
            f"scale=320:-2,select='gt(scene,{threshold})',showinfo",
            "-f", "null", "-",
        ],
        check=False,
    )
    times = [float(x) for x in re.findall(r"pts_time:([\d.]+)", p.stderr or "")]
    cuts: list[float] = []
    for t in sorted(times):
        if t < MIN_SHOT_GAP or t > duration - MIN_SHOT_GAP:
            continue
        if cuts and t - cuts[-1] < MIN_SHOT_GAP:
            continue
        cuts.append(round(t, 3))
    return cuts


def pick_later_times(cuts: list[float], duration: float) -> list[float]:
    # Ported from reel-watcher (MIT, © 2026 Jacob Bruce): src/reel_watcher/study.py
    cand = [c + 0.15 for c in cuts if c > 3.0]
    times: list[float] = []
    for t in cand:
        if not times or t - times[-1] >= LATER_INTERVAL:
            times.append(t)
    t = 3.0 + LATER_INTERVAL
    while t < duration - 0.3:
        if all(abs(t - x) >= LATER_INTERVAL * 0.6 for x in times):
            times.append(t)
        t += LATER_INTERVAL
    times = sorted(x for x in times if x < duration - 0.1)
    if len(times) > MAX_LATER_FRAMES:
        step = len(times) / MAX_LATER_FRAMES
        times = [times[int(i * step)] for i in range(MAX_LATER_FRAMES)]
    return times


def extract_frames_at(
    video: Path,
    times: list[float],
    dest: Path,
    prefix: str = "f",
) -> list[tuple[float, Path]]:
    # Ported from reel-watcher (MIT, © 2026 Jacob Bruce): src/reel_watcher/study.py
    dest.mkdir(parents=True, exist_ok=True)
    out: list[tuple[float, Path]] = []
    for t in times:
        f = dest / f"{prefix}_{int(round(t * 100)):06d}.jpg"
        subprocess.run(
            [
                "ffmpeg", "-nostdin", "-v", "error", "-y",
                "-ss", f"{t:.2f}", "-i", str(video),
                "-frames:v", "1", "-vf", "scale='min(896,iw)':-2",
                "-q:v", "3", str(f),
            ],
            check=False,
            capture_output=True,
        )
        if f.exists() and f.stat().st_size > 0:
            out.append((t, f))
    return out


def dhash_bits(path: Path, size: int = 8) -> int:
    # Ported from reel-watcher (MIT, © 2026 Jacob Bruce): src/reel_watcher/study.py
    from PIL import Image

    with Image.open(path) as im:
        g = im.convert("L").resize((size + 1, size), Image.LANCZOS)
        px = list(g.tobytes())
    bits = 0
    for r in range(size):
        for c in range(size):
            bits = (bits << 1) | (
                1 if px[r * (size + 1) + c] > px[r * (size + 1) + c + 1] else 0
            )
    return bits


def _norm_text(t: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (t or "").lower()).strip()


def text_changed(a: str, b: str) -> bool:
    # Ported from reel-watcher (MIT, © 2026 Jacob Bruce): src/reel_watcher/study.py
    import difflib

    na, nb = _norm_text(a), _norm_text(b)
    if na == nb:
        return False
    if not na or not nb:
        return True
    return difflib.SequenceMatcher(None, na, nb).ratio() < 0.8


def dedupe_frames(
    hashes: list[int],
    texts: list[str],
    thr: int = DEDUPE_HASH_DIST,
    cap: int = MAX_UNIQUE_FRAMES,
) -> tuple[list[int], list[int]]:
    # Ported from reel-watcher (MIT, © 2026 Jacob Bruce): src/reel_watcher/study.py
    uniq: list[int] = []
    rep = [0] * len(hashes)
    for i, h in enumerate(hashes):
        best, bd = None, 10**9
        for u in uniq:
            d = bin(h ^ hashes[u]).count("1")
            if d < bd:
                best, bd = u, d
        if best is not None and bd <= thr and not text_changed(texts[best], texts[i]):
            rep[i] = best
        else:
            uniq.append(i)
            rep[i] = i
    while len(uniq) > cap:
        best = None
        for x in range(len(uniq)):
            for y in range(x + 1, len(uniq)):
                i, j = uniq[x], uniq[y]
                d = bin(hashes[i] ^ hashes[j]).count("1") + (
                    32 if text_changed(texts[i], texts[j]) else 0
                )
                if best is None or d < best[0]:
                    best = (d, x, y)
        assert best is not None
        _, x, y = best
        gone, keep = uniq.pop(y), uniq[x]
        rep = [keep if r == gone else r for r in rep]
    return uniq, rep


def pick_keyframe(times_paths: list[tuple[float, Path]]) -> Optional[Path]:
    """Nearest frame to t=1.0 s."""
    if not times_paths:
        return None
    return min(times_paths, key=lambda tp: abs(tp[0] - 1.0))[1]
