"""Apify Free-plan Instagram fetcher. Actor: apify~instagram-scraper only."""
from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Optional
from urllib.parse import urlparse

import requests

from reelvault import db
from reelvault.guardrails import (
    GuardrailError,
    can_run_batch,
    credit_used,
    fetch_apify_limits,
    run_cap_usd,
    with_backoff,
)

ACTOR = "apify~instagram-scraper"
START_URL = f"https://api.apify.com/v2/acts/{ACTOR}/runs"
POLL_EVERY_S = 5
POLL_TIMEOUT_S = 900

# Matches /reel/, /reels/, /p/, /tv/ — reels → reel.
_PATH_RE = re.compile(
    r"instagram\.com/(?P<kind>reels?|p|tv)/(?P<code>[A-Za-z0-9_-]+)",
    re.I,
)


class FetchError(Exception):
    pass


# Permanent Instagram outcomes — everything else is retryable (`failed`).
_PERMANENT_MARKERS = (
    "not found",
    "doesn't exist",
    "does not exist",
    "removed",
    "deleted",
    "private",
    "restricted",
    "unavailable",
)


def classify_apify_error(message: str) -> str:
    """Return 'unavailable' for permanent failures, else 'failed'."""
    low = (message or "").lower()
    if any(m in low for m in _PERMANENT_MARKERS):
        return "unavailable"
    return "failed"


@dataclass
class FetchResult:
    caption: Optional[str] = None
    video_url: Optional[str] = None
    image_urls: list[str] = field(default_factory=list)
    author: Optional[str] = None
    duration_s: Optional[float] = None
    music: Optional[str] = None
    taken_at: Optional[str] = None
    error: Optional[str] = None
    shortcode: Optional[str] = None


def normalize_url(url: str) -> Optional[tuple[str, str, str]]:
    """Return (kind, code, clean_url) or None for non-Instagram URLs.

    kind ∈ {reel, p, tv}; 'reels' collapses to 'reel'.
    """
    if not url:
        return None
    m = _PATH_RE.search(url)
    if not m:
        return None
    kind = m.group("kind").lower()
    if kind == "reels":
        kind = "reel"
    code = m.group("code")
    clean = f"https://www.instagram.com/{kind}/{code}/"
    # Reject hosts that aren't Instagram even if path matched somehow.
    host = (urlparse(url).hostname or "").lower().removeprefix("www.")
    if not host.endswith("instagram.com"):
        return None
    return kind, code, clean


def map_item(item: dict) -> FetchResult:
    """Map one Apify dataset item to FetchResult. Missing fields → absent."""
    err = item.get("error") or item.get("errorDescription")
    if err:
        return FetchResult(
            error=str(item.get("errorDescription") or item.get("error"))[:300],
            shortcode=item.get("shortCode"),
        )

    caption = (item.get("caption") or "").strip() or None
    video_url = item.get("videoUrl") or None
    if not video_url:
        for child in item.get("childPosts") or []:
            if child.get("videoUrl"):
                video_url = child["videoUrl"]
                break

    image_urls: list[str] = []
    seen: set[str] = set()

    def add(u: Optional[str]) -> None:
        if u and u not in seen and len(image_urls) < 10:
            seen.add(u)
            image_urls.append(u)

    add(item.get("displayUrl"))
    for child in item.get("childPosts") or []:
        add(child.get("displayUrl"))
    for u in item.get("images") or []:
        add(u)

    duration = item.get("videoDuration")
    duration_s = float(duration) if isinstance(duration, (int, float)) and duration >= 0 else None

    music = None
    mi = item.get("musicInfo")
    if isinstance(mi, dict):
        music = json.dumps(
            {
                "song": mi.get("song_name"),
                "artist": mi.get("artist_name"),
                "original": bool(mi.get("uses_original_audio")),
            },
            ensure_ascii=False,
        )

    return FetchResult(
        caption=caption,
        video_url=video_url,
        image_urls=image_urls,
        author=item.get("ownerUsername") or None,
        duration_s=duration_s,
        music=music,
        taken_at=item.get("timestamp"),
        shortcode=item.get("shortCode"),
    )


def run_batch(
    urls: list[str],
    token: str,
    cap_usd: float,
    session: Optional[requests.Session] = None,
) -> tuple[list[dict], dict]:
    """Start actor run, poll, return (items, run_summary)."""
    sess = session or requests.Session()
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    body = {
        "directUrls": urls,
        "resultsType": "posts",
        "resultsLimit": 1,
        "addParentData": False,
    }

    def start() -> requests.Response:
        r = sess.post(
            f"{START_URL}?maxTotalChargeUsd={cap_usd}",
            headers=headers,
            json=body,
            timeout=60,
        )
        if r.status_code == 429:
            # Surface as HTTPError so with_backoff retries.
            r.raise_for_status()
        r.raise_for_status()
        return r

    start_resp = with_backoff(start)
    data = start_resp.json().get("data") or {}
    run_id = data.get("id")
    dataset_id = data.get("defaultDatasetId")
    if not run_id or not dataset_id:
        raise FetchError(f"Apify start missing ids: {start_resp.text[:200]}")

    deadline = time.time() + POLL_TIMEOUT_S
    status = data.get("status") or "READY"
    run_data = data
    while status in ("READY", "RUNNING"):
        if time.time() > deadline:
            raise FetchError(f"Apify run {run_id} timed out after {POLL_TIMEOUT_S}s")
        time.sleep(POLL_EVERY_S)

        def poll() -> requests.Response:
            r = sess.get(
                f"https://api.apify.com/v2/actor-runs/{run_id}",
                headers={"Authorization": f"Bearer {token}"},
                timeout=30,
            )
            if r.status_code == 429:
                r.raise_for_status()
            r.raise_for_status()
            return r

        run_data = with_backoff(poll).json().get("data") or {}
        status = run_data.get("status") or "UNKNOWN"

    if status != "SUCCEEDED":
        msg = run_data.get("statusMessage") or status
        raise FetchError(f"Apify run {run_id} failed: {msg}")

    def items_get() -> requests.Response:
        r = sess.get(
            f"https://api.apify.com/v2/datasets/{dataset_id}/items",
            params={"clean": "true", "format": "json"},
            headers={"Authorization": f"Bearer {token}"},
            timeout=60,
        )
        if r.status_code == 429:
            r.raise_for_status()
        r.raise_for_status()
        return r

    items = with_backoff(items_get).json()
    if not isinstance(items, list):
        items = []

    summary = {
        "run_id": run_id,
        "dataset_id": dataset_id,
        "status": status,
        "items": len(items),
        "usd": run_data.get("usageTotalUsd"),
    }
    return items, summary


def fetch_batch(
    con: Any,
    rows: list[Any],
    token: str,
    *,
    dry_run: bool = False,
    session: Optional[requests.Session] = None,
    limits: Optional[dict] = None,
) -> tuple[dict[str, FetchResult], dict[str, int]]:
    """Normalise, guardrail, run, ledger, apply.

    Returns (shortcode → FetchResult, counts{fetched,failed,unavailable}).
    On dry_run: no POST. Raises GuardrailError / FetchError on hard stops.
    """
    counts = {"fetched": 0, "failed": 0, "unavailable": 0}
    by_code: dict[str, list[Any]] = {}
    clean_urls: list[str] = []
    for row in rows:
        norm = normalize_url(row["url"])
        if not norm:
            db.save(
                con,
                row["id"],
                content_status="unavailable",
                content_error="not an Instagram reel/post URL",
            )
            counts["unavailable"] += 1
            continue
        _kind, code, clean = norm
        if code not in by_code:
            by_code[code] = []
            clean_urls.append(clean)
        by_code[code].append(row)

    if not clean_urls:
        return {}, counts

    if dry_run:
        return {}, counts

    lim = limits if limits is not None else fetch_apify_limits(token, session=session)
    ok, reason = can_run_batch(lim, len(clean_urls))
    if not ok:
        raise GuardrailError(reason)
    cap = run_cap_usd(lim, len(clean_urls))

    items, summary = run_batch(clean_urls, token, cap, session=session)

    results_by_code: dict[str, dict] = {}
    for it in items:
        code = it.get("shortCode")
        if not code:
            norm = normalize_url(it.get("url") or "")
            code = norm[1] if norm else None
        if code:
            results_by_code[code] = it

    try:
        after = fetch_apify_limits(token, session=session)
        monthly_after = credit_used(after)
    except Exception:  # noqa: BLE001
        monthly_after = summary.get("usd")

    db.append_ledger(
        con,
        at=datetime.now(timezone.utc).isoformat(),
        provider="apify",
        run_id=summary.get("run_id"),
        items=len(clean_urls),
        usd_reported=summary.get("usd"),
        monthly_usage_after=monthly_after,
    )

    out: dict[str, FetchResult] = {}
    for code, code_rows in by_code.items():
        it = results_by_code.get(code)
        if not it:
            fr = FetchResult(error="apify: not returned", shortcode=code)
            for row in code_rows:
                db.save(
                    con,
                    row["id"],
                    content_status="failed",
                    content_error="apify: not returned",
                )
                counts["failed"] += 1
            out[code] = fr
            continue

        fr = map_item(it)
        out[code] = fr
        if fr.error:
            status = classify_apify_error(fr.error)
            err = f"apify: {fr.error}"[:300]
            for row in code_rows:
                db.save(con, row["id"], content_status=status, content_error=err)
                counts[status] += 1
            continue

        for row in code_rows:
            patch: dict[str, Any] = {
                "content_status": "fetched",
                "fetcher": "apify",
                "content_error": None,
            }
            if fr.caption:
                patch["caption"] = fr.caption
            if fr.video_url:
                try:
                    from .url_safety import assert_public_http_url

                    assert_public_http_url(fr.video_url)
                    patch["video"] = fr.video_url
                except ValueError:
                    pass
            if fr.author:
                patch["author"] = fr.author
            if fr.duration_s is not None:
                patch["duration_s"] = fr.duration_s
            if fr.music:
                patch["music"] = fr.music
            if fr.image_urls and not row["thumbnail"]:
                try:
                    from .url_safety import assert_public_http_url

                    assert_public_http_url(fr.image_urls[0])
                    patch["thumbnail"] = fr.image_urls[0]
                except ValueError:
                    pass
            title = row["title"] or ""
            if fr.caption and (not title or title.startswith("Shared by ")):
                patch["title"] = fr.caption.splitlines()[0][:120]
            db.save(con, row["id"], **patch)
            counts["fetched"] += 1

    return out, counts

