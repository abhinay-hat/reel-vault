"""Guardrails unit tests — no network."""
from __future__ import annotations

import types

import pytest
import requests

from reelvault import guardrails as g


def _limits(used: float, max_usd: float = 5.0, end: str = "2026-11-01T00:00:00.000Z"):
    return {
        "data": {
            "current": {"monthlyUsageUsd": used},
            "limits": {"maxMonthlyUsageUsd": max_usd},
            "monthlyUsageCycle": {"endAt": end},
        }
    }


def test_assert_free_plan_at_5():
    g.assert_free_plan(_limits(0, max_usd=5.0))


def test_assert_free_plan_rejects_paid():
    with pytest.raises(g.GuardrailError, match="paid plan"):
        g.assert_free_plan(_limits(0, max_usd=5.01))


def test_credit_boundary():
    # Spec: estimate = n*0.003 + 0.001. 15 → $0.046.
    # 4.46 + 0.046 = 4.506 > 4.50 → refuse; 4.40 + 0.046 = 4.446 → allow.
    # (Prompt's 4.45 figure is $0.004 shy of the hard stop under exact math.)
    ok, reason = g.can_run_batch(_limits(4.46), 15)
    assert ok is False
    assert "2026-11-01" in reason

    ok2, _ = g.can_run_batch(_limits(4.40), 15)
    assert ok2 is True


def test_run_cap_rounding():
    # used 4.40, n=15 → est 0.046; min(0.10, 0.069)=0.069 → floor cents 0.06
    cap = g.run_cap_usd(_limits(4.40), 15)
    assert cap == 0.06


def test_disk_check(monkeypatch):
    monkeypatch.setattr(
        g.shutil, "disk_usage",
        lambda _p: types.SimpleNamespace(free=2 * 1024**3, total=10, used=8),
    )
    ok, free = g.check_disk("/tmp")
    assert ok is False
    assert free == 2 * 1024**3

    monkeypatch.setattr(
        g.shutil, "disk_usage",
        lambda _p: types.SimpleNamespace(free=4 * 1024**3, total=10, used=6),
    )
    ok2, _ = g.check_disk("/tmp")
    assert ok2 is True


def test_backoff_fake_clock():
    sleeps: list[float] = []
    calls = {"n": 0}

    class FakeResp:
        status_code = 429
        headers = {"Retry-After": "12"}

    def flaky():
        calls["n"] += 1
        if calls["n"] < 3:
            err = requests.HTTPError("429")
            err.response = FakeResp()
            raise err
        return "ok"

    out = g.with_backoff(flaky, max_tries=3, sleep=sleeps.append)
    assert out == "ok"
    assert sleeps == [12.0, 12.0]
