"""Make the pip-installed NVIDIA DLLs (cuBLAS, cuDNN) loadable on Windows.

faster-whisper (CTranslate2) and onnxruntime-gpu (RapidOCR) both need them.
"""
from __future__ import annotations

import os
from pathlib import Path

_done = False


def add_nvidia_dlls() -> None:
    global _done
    if _done or os.name != "nt":
        return
    import site

    for sp in site.getsitepackages():
        for bin_dir in Path(sp, "nvidia").glob("*/bin"):
            os.add_dll_directory(str(bin_dir))
            os.environ["PATH"] = f"{bin_dir}{os.pathsep}{os.environ['PATH']}"
    _done = True
