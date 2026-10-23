"""Opt-in Instagram sidecar fetcher. Ban risk — never the default path."""
from __future__ import annotations

import os
import re
import time
from typing import Any, Optional

import requests

from reelvault.db import save

BRIDGE_URL = os.environ.get("IG_BRIDGE_URL", "http://127.0.0.1:8765")
SHORTCODE_RE = re.compile(r"instagram\.com/(?:reel|reels|p|tv)/([A-Za-z0-9_-]+)")

_warned = False
_stop = False


def set_stop(flag: bool = True) -> None:
    global _stop
    _stop = flag


def shortcode(url: str) -> Optional[str]:
    m = SHORTCODE_RE.search(url or "")
    return m.group(1) if m else None


def fetch_caption(con: Any, item: Any) -> str:
    """Ask the sidecar for this reel's caption and media URLs.

    Returns the next content_status. The sidecar owns all pacing decisions; this
    function's only job is to obey what it says, including sleeping out a
    cooldown that may be hours long.
    """
    global _warned
    if not _warned:
        print(
            "  WARNING: --fetcher sidecar uses Instagram's private API "
            "(ToS risk / ban risk). Prefer Apify Free for the default path."
        )
        _warned = True

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
            save(con, item["id"], content_status="failed",
                 content_error=f"bridge unreachable: {e}")
            print(f"    bridge unreachable ({e}) — is ig-bridge running?")
            return "failed"

        err = data.get("error")
        if err == "too_soon":
            wait = int(data.get("retry_in_s", 25)) + 1
            time.sleep(wait)
            continue
        if err == "cooldown":
            wait = int(data.get("retry_in_s", 3600))
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
        patch: dict[str, Any] = {
            "content_status": "fetched",
            "fetcher": "sidecar",
            "content_error": None,
        }
        if caption:
            patch["caption"] = caption
        if data.get("video_url"):
            patch["video"] = data["video_url"]
        if data.get("thumbnail_url") and not item["thumbnail"]:
            patch["thumbnail"] = data["thumbnail_url"]
        if data.get("author"):
            patch["author"] = data["author"]
        if caption and (not item["title"] or item["title"].startswith("Shared by")):
            patch["title"] = caption.splitlines()[0][:120]
        save(con, item["id"], **patch)
        return "fetched"

    return "stopped"
