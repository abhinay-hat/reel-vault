"""Spend and safety gates. Pure functions + thin HTTP. Never switches provider."""
from __future__ import annotations

import math
import shutil
import time
from typing import Any, Callable, Optional, TypeVar

import requests

ALLOWED_LLM_MODELS = {
    "local": ["mlx-community/Qwen3-4B-Instruct-2507-4bit"],
    "groq": ["openai/gpt-oss-120b", "openai/gpt-oss-20b"],
}

CREDIT_STOP_USD = 4.50
PER_ITEM_USD = 0.003
PER_RUN_USD = 0.001
MIN_FREE_DISK_BYTES = 3 * 1024**3

T = TypeVar("T")


class GuardrailError(Exception):
    pass


class RateLimited(Exception):
    pass


def fetch_apify_limits(token: str, session: Optional[requests.Session] = None) -> dict:
    """GET /v2/users/me/limits. Raises GuardrailError on 401/403."""
    sess = session or requests
    r = sess.get(
        "https://api.apify.com/v2/users/me/limits",
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    if r.status_code in (401, 403):
        raise GuardrailError(
            f"Apify auth failed ({r.status_code}). Check APIFY_TOKEN."
        )
    r.raise_for_status()
    return r.json()


def assert_free_plan(limits: dict) -> None:
    data = limits.get("data") or {}
    lim = data.get("limits") or {}
    max_usd = lim.get("maxMonthlyUsageUsd")
    if max_usd is None:
        return
    if float(max_usd) > 5:
        raise GuardrailError(
            f"Apify account is on a paid plan (maxMonthlyUsageUsd={max_usd}). "
            "Use a free account with no card attached."
        )


def estimate_batch_usd(n: int) -> float:
    return n * PER_ITEM_USD + PER_RUN_USD


def credit_used(limits: dict) -> float:
    data = limits.get("data") or {}
    current = data.get("current") or {}
    return float(current.get("monthlyUsageUsd") or 0)


def credit_left(limits: dict) -> float:
    return max(0.0, CREDIT_STOP_USD - credit_used(limits))


def cycle_end(limits: dict) -> str:
    data = limits.get("data") or {}
    cycle = data.get("monthlyUsageCycle") or {}
    return str(cycle.get("endAt") or "unknown")


def can_run_batch(limits: dict, n: int) -> tuple[bool, str]:
    used = credit_used(limits)
    est = estimate_batch_usd(n)
    if used + est > CREDIT_STOP_USD:
        return (
            False,
            f"credit stop: used ${used:.4f} + estimate ${est:.4f} > ${CREDIT_STOP_USD:.2f}; "
            f"next cycle {cycle_end(limits)}",
        )
    return True, "ok"


def floor_to_cents(x: float) -> float:
    return math.floor(x * 100) / 100


def run_cap_usd(limits: dict, n: int) -> float:
    """Per-run maxTotalChargeUsd. Caller must have passed can_run_batch."""
    used = credit_used(limits)
    est = estimate_batch_usd(n)
    raw = min(CREDIT_STOP_USD - used, est * 1.5)
    capped = floor_to_cents(raw)
    return max(0.01, capped)


def check_disk(path: str | Any) -> tuple[bool, int]:
    free = shutil.disk_usage(str(path)).free
    return free >= MIN_FREE_DISK_BYTES, free


def with_backoff(
    fn: Callable[[], T],
    *,
    max_tries: int = 3,
    sleep: Callable[[float], None] = time.sleep,
) -> T:
    """Retry on HTTP 429. Never switches provider or model."""
    last: Optional[BaseException] = None
    for attempt in range(max_tries):
        try:
            return fn()
        except requests.HTTPError as e:
            last = e
            resp = e.response
            if resp is None or resp.status_code != 429:
                raise
            if attempt + 1 >= max_tries:
                raise RateLimited("rate limited after 3 tries") from e
            wait = 60.0
            ra = resp.headers.get("Retry-After")
            if ra:
                try:
                    wait = float(ra)
                except ValueError:
                    wait = 60.0
            sleep(wait)
        except requests.RequestException:
            raise
    raise RateLimited("rate limited after 3 tries") from last
