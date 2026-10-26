"""
Reel Vault — Instagram private-API sidecar (instagrapi).

Local-only FastAPI service. Binds to 127.0.0.1 so the session/credential never
leaves this machine. The Vite + Hono app talks to it over http://127.0.0.1:8765.

WARNING: instagrapi uses Instagram's PRIVATE mobile API. This violates Instagram's
Terms of Service and can get the logged-in account checkpointed, locked, or banned.
Use only with your own account, at your own risk. The sessionid is a full credential.
"""
from __future__ import annotations

import ipaddress
import os
import re
import socket
import tempfile
import threading
import traceback
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urljoin, urlparse, urlunparse

import requests
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from requests.adapters import HTTPAdapter
from instagrapi import Client
from instagrapi.exceptions import (
    LoginRequired,
    ChallengeRequired,
    PleaseWaitFewMinutes,
    ClientThrottledError,
    TwoFactorRequired,
    BadPassword,
)

try:  # newer instagrapi: unresolvable "bloks"/STEP_NAME challenges
    from instagrapi.exceptions import ChallengeUnknownStep
except Exception:  # pragma: no cover - older versions
    class ChallengeUnknownStep(Exception):
        pass

SESSION_FILE = Path(os.environ.get("IG_SESSION_FILE", "./ig_session.json"))
URL_RE = re.compile(r"https?://[^\s\"'<>]+")
_ALLOWED_HOSTS = {"127.0.0.1", "localhost", "::1"}
# Client-supplied proxy on /login is ignored unless this flag is set. Prefer
# IG_PROXY for a server-configured hop when you need one.
_ALLOW_CLIENT_PROXY = os.environ.get("IG_ALLOW_CLIENT_PROXY", "").strip().lower() in (
    "1", "true", "yes",
)
_SERVER_PROXY = (os.environ.get("IG_PROXY") or "").strip() or None


def _host_ok(host_header: str | None) -> bool:
    if not host_header:
        return False
    host = host_header.strip()
    if host.startswith("["):
        end = host.find("]")
        name = host[1:end] if end > 0 else host
    else:
        name = host.rsplit(":", 1)[0]
    return name.lower() in _ALLOWED_HOSTS


def _is_private_ip(ip: str) -> bool:
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return True
    return (
        addr.is_private
        or addr.is_loopback
        or addr.is_link_local
        or addr.is_reserved
        or addr.is_multicast
        or addr.is_unspecified
    )


def _resolve_public_ips(host: str) -> list[str]:
    """Resolve host and return addresses only if every one is public."""
    try:
        ipaddress.ip_address(host)
    except ValueError:
        pass
    else:
        return [] if _is_private_ip(host) else [host]
    try:
        infos = socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
    except socket.gaierror:
        return []
    ips: list[str] = []
    seen: set[str] = set()
    for info in infos:
        ip = info[4][0]
        if ip in seen:
            continue
        seen.add(ip)
        if _is_private_ip(ip):
            return []
        ips.append(ip)
    return ips


def _public_http_url(url: str) -> bool:
    """Reject file paths, file://, and http(s) URLs that resolve to private IPs."""
    if not url or url.startswith("/") or url.startswith("\\") or "://" not in url:
        return False
    try:
        u = urlparse(url)
    except Exception:
        return False
    if u.scheme not in ("http", "https"):
        return False
    if u.username or u.password or not u.hostname:
        return False
    host = u.hostname.lower()
    if host in {"localhost", "metadata.google.internal"}:
        return False
    return bool(_resolve_public_ips(host))


class _PinnedIPAdapter(HTTPAdapter):
    """Keep SNI/cert hostname when connecting via a literal IP URL."""

    def __init__(self, server_hostname: str, **kwargs: Any):
        self._server_hostname = server_hostname
        super().__init__(**kwargs)

    def init_poolmanager(self, *args: Any, **kwargs: Any) -> Any:
        kwargs["server_hostname"] = self._server_hostname
        kwargs["assert_hostname"] = self._server_hostname
        return super().init_poolmanager(*args, **kwargs)


def _url_with_pinned_ip(url: str, ip: str) -> tuple[str, str]:
    u = urlparse(url)
    assert u.hostname is not None
    host_header = u.hostname if not u.port else f"{u.hostname}:{u.port}"
    netloc = f"[{ip}]" if ":" in ip else ip
    if u.port:
        netloc = f"{netloc}:{u.port}"
    pinned = urlunparse((u.scheme, netloc, u.path or "", u.params, u.query, u.fragment))
    return pinned, host_header


def _chmod_session() -> None:
    try:
        if SESSION_FILE.exists():
            os.chmod(SESSION_FILE, 0o600)
    except OSError:
        pass

# Risk throttles (instagrapi best practices: low frequency, hard cooldowns).
MIN_GATHER_INTERVAL_S = float(os.environ.get("IG_MIN_GATHER_INTERVAL_HOURS", "20")) * 3600
COOLDOWN_S = float(os.environ.get("IG_COOLDOWN_HOURS", "6")) * 3600
# Backfilling captions means one private-API call per reel, hundreds of times.
# 25s between calls (~140/hour) keeps that closer to a person scrolling than a
# scraper draining a list. Lower it and you are gambling with the account.
MEDIA_MIN_INTERVAL_S = float(os.environ.get("IG_MEDIA_MIN_INTERVAL_SECONDS", "25"))

app = FastAPI(title="reel-vault-ig-bridge")


@app.middleware("http")
async def _reject_bad_host(request: Request, call_next):  # type: ignore[no-untyped-def]
    # DNS-rebinding defense: only answer Host headers for loopback names.
    if not _host_ok(request.headers.get("host")):
        return JSONResponse({"error": "bad_host"}, status_code=400)
    return await call_next(request)


# Single connected client + a tiny in-memory job table for long gathers.
_state: dict[str, Any] = {
    "client": None, "username": None, "user_id": None,
    "last_gather_at": 0.0,   # epoch seconds of last gather start
    "last_media_at": 0.0,    # epoch seconds of last per-reel media lookup
    "cooldown_until": 0.0,   # epoch seconds; set after rate-limit/challenge
    # Why there is no client, so the app can say "session expired" instead of
    # the ambiguous "not connected". none = never linked; expired = Instagram
    # rejected the session file we still hold on disk.
    "session_status": "none",   # none | active | expired
    "session_error": None,
    "restore_retry_at": 0.0,    # epoch seconds; backoff between restore attempts
}

# Instagram invalidates browser sessions on its own schedule. Re-validating on
# every request would hammer the private API (and look like a bot), so a failed
# restore is retried at most this often.
RESTORE_RETRY_S = float(os.environ.get("IG_RESTORE_RETRY_SECONDS", "60"))
_jobs: dict[str, dict[str, Any]] = {}
_lock = threading.Lock()


def _mark_session_expired(reason: str) -> None:
    """Instagram refused the session we hold: drop it and start the retry timer.

    The session FILE is deliberately kept — the device UUIDs inside it make a
    re-login look like the same phone, which is what keeps checkpoints away.
    """
    import time as _time
    _state["client"] = None
    _state["session_status"] = "expired"
    _state["session_error"] = reason
    _state["restore_retry_at"] = _time.time() + RESTORE_RETRY_S


def _enter_cooldown(reason: str) -> None:
    import time as _time
    _state["cooldown_until"] = _time.time() + COOLDOWN_S
    _state["cooldown_reason"] = reason


# ----------------------------- helpers -----------------------------

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _to_iso(dt: Optional[datetime]) -> Optional[str]:
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat()


def _parse_bound(s: Optional[str]) -> Optional[datetime]:
    if not s:
        return None
    dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _in_range(dt: Optional[datetime], lo: Optional[datetime], hi: Optional[datetime]) -> bool:
    if dt is None:
        return True
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    if lo and dt < lo:
        return False
    if hi and dt > hi:
        return False
    return True


def _effective_proxy(client_proxy: Optional[str]) -> Optional[str]:
    """Resolve proxy for a new Client. Client body is ignored by default."""
    if _ALLOW_CLIENT_PROXY and client_proxy:
        return client_proxy.strip() or None
    return _SERVER_PROXY


def _make_client(proxy: Optional[str]) -> Client:
    cl = Client()
    cl.delay_range = [1, 3]  # human-like pause between every private request
    if proxy:
        cl.set_proxy(proxy)
    cl.set_locale("en_US")
    cl.set_country("US")
    # Reuse the previous device identity even when the old session is invalid.
    # A fresh login from a brand-new "device" is the single biggest checkpoint
    # trigger; keeping UUIDs stable makes a re-login look like the same phone.
    if SESSION_FILE.exists():
        try:
            import json as _json
            old = _json.loads(SESSION_FILE.read_text())
            if isinstance(old, dict) and old.get("uuids"):
                cl.set_uuids(old["uuids"])
            if isinstance(old, dict) and old.get("device_settings"):
                cl.set_device(old["device_settings"])
        except Exception:
            pass
    return cl


def _try_restore_session() -> None:
    """Auto-restore a persisted session so login survives uvicorn restarts.

    Called lazily at the top of endpoints that need a client. Only attempts
    restore when: (a) client is currently None, and (b) SESSION_FILE exists.
    Never loops; a single failure leaves state as-is (stayed logged out).
    """
    import time as _time
    if _state["client"] is not None:
        _state["session_status"] = "active"
        return
    if not SESSION_FILE.exists():
        # Nothing was ever saved (or "switch account" deleted it): this is a
        # never-connected state, not an expiry.
        _state["session_status"] = "none"
        _state["session_error"] = None
        return
    # A session file exists but produced no client last time. Retry on a timer
    # instead of on every request.
    if _time.time() < _state["restore_retry_at"]:
        return
    try:
        cl = _make_client(None)
        cl.load_settings(SESSION_FILE)
        cl.get_timeline_feed()          # validates the session is still alive
        info = cl.account_info()
        _state["client"] = cl
        _state["username"] = info.username
        _state["user_id"] = str(info.pk)
        _state["session_status"] = "active"
        _state["session_error"] = None
        _state["restore_retry_at"] = 0.0
        _state.pop("pending", None)
    except Exception as e:  # noqa: BLE001
        # The saved session is on disk but Instagram will not honour it. Say so
        # explicitly; the app turns this into "your session expired".
        _state["session_status"] = "expired"
        _state["session_error"] = f"{type(e).__name__}"
        _state["restore_retry_at"] = _time.time() + RESTORE_RETRY_S


@app.on_event("startup")
def _startup_restore() -> None:
    """Best-effort session restore on service startup."""
    _try_restore_session()


def _require_client() -> Client:
    cl = _state["client"]
    if cl is None:
        raise LoginRequired("not logged in")
    return cl


def _build_permalink(media: Any) -> Optional[str]:
    code = getattr(media, "code", None)
    if not code:
        return None
    mt = getattr(media, "media_type", None)
    pt = getattr(media, "product_type", "") or ""
    if mt == 2 and pt == "clips":
        return f"https://www.instagram.com/reel/{code}/"
    return f"https://www.instagram.com/p/{code}/"


def _classify(media: Any) -> str:
    mt = getattr(media, "media_type", None)
    pt = getattr(media, "product_type", "") or ""
    return "reel" if (mt == 2 and pt == "clips") else "post"


def _media_to_item(media: Any, source: str) -> dict[str, Any]:
    user = getattr(media, "user", None)
    return {
        "type": _classify(media),
        "pk": str(getattr(media, "pk", "")),
        "code": getattr(media, "code", None),
        "permalink": _build_permalink(media),
        "taken_at": _to_iso(getattr(media, "taken_at", None)),
        "saved_at": _now_iso(),
        "caption_text": getattr(media, "caption_text", None),
        "author": getattr(user, "username", None) if user else None,
        "thumbnail_url": str(getattr(media, "thumbnail_url", "") or "") or None,
        "video_url": str(getattr(media, "video_url", "") or "") or None,
        "like_count": getattr(media, "like_count", None),
        "play_count": getattr(media, "play_count", None),
        "source": source,
    }


# ----------------------------- request models -----------------------------

class LoginReq(BaseModel):
    sessionid: Optional[str] = None
    username: Optional[str] = None
    password: Optional[str] = None
    verification_code: Optional[str] = None  # 2FA TOTP / SMS code
    proxy: Optional[str] = None


class GatherReq(BaseModel):
    content_types: list[str] = ["saved", "reels", "dms", "articles"]
    thread_ids: list[str] = []
    sender_ids: list[str] = []  # filter DMs/articles by sender user_id; empty = all
    collection_pks: list[str] = []
    date_from: Optional[str] = None
    date_to: Optional[str] = None
    thread_message_limit: int = 0   # 0 = every message instagrapi will page through
    thread_limit: int = 200         # threads to scan per inbox box
    force: bool = False  # bypass the min-interval throttle (NOT the cooldown)


# ----------------------------- endpoints -----------------------------

@app.get("/health")
def health() -> dict[str, Any]:
    import time as _time
    _try_restore_session()
    now = _time.time()
    last = _state["last_gather_at"]
    # next_gather_in_s is what the /gather throttle will actually enforce, so
    # the app can show a real "next sync available" instead of guessing.
    return {"ok": True, "logged_in": _state["client"] is not None, "username": _state["username"],
            "cooling_down": now < _state["cooldown_until"],
            "cooldown_reason": _state.get("cooldown_reason") if now < _state["cooldown_until"] else None,
            "cooldown_in_s": max(0, int(_state["cooldown_until"] - now)),
            "session_status": _state["session_status"],
            "session_error": _state["session_error"],
            # Seconds until the helper retries the saved session by itself.
            "session_retry_in_s": max(0, int(_state["restore_retry_at"] - now)),
            "min_interval_hours": MIN_GATHER_INTERVAL_S / 3600,
            "last_gather_at": _to_iso(datetime.fromtimestamp(last, tz=timezone.utc)) if last else None,
            "next_gather_in_s": max(0, int(MIN_GATHER_INTERVAL_S - (now - last))) if last else 0}


def _finish(cl: Client) -> dict[str, Any]:
    cl.dump_settings(SESSION_FILE)
    _chmod_session()
    info = cl.account_info()
    _state["client"] = cl
    _state["username"] = info.username
    _state["user_id"] = str(info.pk)
    _state["session_status"] = "active"
    _state["session_error"] = None
    _state["restore_retry_at"] = 0.0
    _state.pop("pending", None)
    return {"ok": True, "user_id": str(info.pk), "username": info.username}


@app.post("/logout")
def logout() -> dict[str, Any]:
    """Disconnect and forget the account so a different one can be linked.

    Deletes the persisted session file (and its device UUIDs) so the next login
    is a clean switch, and clears in-memory state and any throttle/cooldown.
    """
    try:
        if SESSION_FILE.exists():
            SESSION_FILE.unlink()
    except Exception:
        pass
    _state["client"] = None
    _state["username"] = None
    _state["user_id"] = None
    _state.pop("pending", None)
    _state["last_gather_at"] = 0.0
    _state["cooldown_until"] = 0.0
    _state.pop("cooldown_reason", None)
    _state["session_status"] = "none"
    _state["session_error"] = None
    _state["restore_retry_at"] = 0.0
    return {"ok": True}


def _forget_session() -> None:
    """Drop the persisted session + in-memory client so the next login is clean."""
    try:
        if SESSION_FILE.exists():
            SESSION_FILE.unlink()
    except Exception:
        pass
    _state["client"] = None
    _state["username"] = None
    _state["user_id"] = None
    _state.pop("pending", None)


@app.post("/login")
def login(req: LoginReq) -> dict[str, Any]:
    try:
        requested = (req.username or "").strip().lstrip("@").lower()

        # If explicit credentials are for a DIFFERENT account than the one we
        # currently hold, forget the old session+device first. This is what
        # makes "switch account" actually switch instead of silently reusing
        # the previous login.
        if requested:
            current = (_state.get("username") or "").lstrip("@").lower()
            if current and current != requested:
                _forget_session()

        # 1) Reuse a valid persisted session — ONLY when the caller isn't asking
        #    for a specific (different) account. A username/password submit is an
        #    explicit intent to log in as that account, so we skip the cache and
        #    let the credentialed login below decide.
        proxy = _effective_proxy(req.proxy)

        if not requested and not req.sessionid and SESSION_FILE.exists():
            try:
                cl = _make_client(proxy)
                cl.load_settings(SESSION_FILE)
                cl.get_timeline_feed()
                out = _finish(cl)
                out["from_cache"] = True
                return out
            except Exception:
                pass

        # 2) Username/password (optionally with 2FA code), reusing a pending
        #    client from a prior 2FA challenge so the device/flow stays stable.
        if req.username and req.password:
            # Already connected as exactly this account? Reuse, don't re-auth.
            current = (_state.get("username") or "").lstrip("@").lower()
            if (current == requested and _state.get("client") is not None
                    and not req.verification_code):
                return {"ok": True, "user_id": _state.get("user_id"),
                        "username": _state.get("username"), "from_cache": True}
            cl = _state.get("pending") or _make_client(proxy)
            try:
                cl.login(req.username, req.password,
                         verification_code=(req.verification_code or ""))
                return _finish(cl)
            except TwoFactorRequired:
                _state["pending"] = cl  # keep client for the follow-up code submit
                return {"ok": False, "error": "2fa_required",
                        "detail": "Instagram needs a 2-factor code. Re-submit username, password and the code."}

        # 3) Browser sessionid path (recommended, lower ban risk).
        if req.sessionid:
            _forget_session()  # a sessionid is for whatever account owns it
            from urllib.parse import unquote
            raw = req.sessionid.strip()
            # Accept a pasted "sessionid=...; other=..." cookie blob, and the
            # URL-encoded form copied from document.cookie (%3A -> :).
            if "sessionid=" in raw:
                raw = raw.split("sessionid=", 1)[1].split(";", 1)[0].strip()
            sid = unquote(raw)
            cl = _make_client(proxy)
            cl.login_by_sessionid(sid)
            return _finish(cl)

        return {"ok": False, "error": "no_credentials",
                "detail": "Provide either a sessionid, or a username and password."}
    except BadPassword:
        return {"ok": False, "error": "bad_password", "detail": "Wrong username or password."}
    except AssertionError:
        return {"ok": False, "error": "invalid_sessionid"}
    except (ChallengeRequired, ChallengeUnknownStep):
        _state.pop("pending", None)
        return {"ok": False, "error": "challenge_required",
                "detail": "Instagram blocked this password login with a security challenge it won't let a script solve. Use the session id method below instead, or approve the login inside the Instagram app first and retry."}
    except (PleaseWaitFewMinutes, ClientThrottledError):
        return {"ok": False, "error": "rate_limited", "detail": "Instagram throttled the login. Wait a few minutes and try again."}
    except Exception as e:  # noqa: BLE001
        # The new bloks challenges can surface as a generic exception too.
        # Never return exception text to the client (paths / internals leak).
        msg = f"{type(e).__name__}: {e}"
        if "challenge" in msg.lower() or "STEP_NAME" in msg:
            _state.pop("pending", None)
            return {"ok": False, "error": "challenge_required",
                    "detail": "Instagram blocked this password login with a security challenge it won't let a script solve. Use the session id method below instead, or approve the login inside the Instagram app first and retry."}
        return {"ok": False, "error": "login_failed", "detail": "Login failed."}


@app.get("/account-info")
def account_info() -> dict[str, Any]:
    _try_restore_session()
    try:
        cl = _require_client()
        info = cl.account_info()
        return {"logged_in": True, "user_id": str(info.pk), "username": info.username,
                "full_name": info.full_name, "profile_pic_url": str(info.profile_pic_url or ""),
                "media_count": getattr(info, "media_count", 0)}
    except LoginRequired:
        _mark_session_expired("LoginRequired")
        return {"logged_in": False, "error": "login_required"}
    except Exception:  # noqa: BLE001
        return {"logged_in": False, "error": "account_error"}


@app.get("/media/{shortcode}")
def media_by_shortcode(shortcode: str) -> dict[str, Any]:
    """Fetch one reel's caption, author, and media URLs by its shortcode.

    This is the endpoint that turns a DM-shared link into something readable:
    Instagram's share payload carries only the URL, so the caption has to be
    fetched back one reel at a time.

    That "one at a time" is the whole risk. A vault of a few hundred reels means
    a few hundred private-API calls, and a tight loop of those is exactly the
    signature that gets an account checkpointed. So this endpoint paces itself:
    it refuses to run faster than MEDIA_MIN_INTERVAL_S, it honours the global
    cooldown, and it enters cooldown the moment Instagram pushes back. The
    caller cannot opt out of the pacing — a caller in a hurry is precisely who
    it is protecting.
    """
    import time as _time
    import random as _random

    now = _time.time()
    if now < _state["cooldown_until"]:
        return {"error": "cooldown",
                "retry_in_s": int(_state["cooldown_until"] - now),
                "reason": _state.get("cooldown_reason")}

    since_last = now - _state.get("last_media_at", 0.0)
    if since_last < MEDIA_MIN_INTERVAL_S:
        return {"error": "too_soon", "retry_in_s": int(MEDIA_MIN_INTERVAL_S - since_last) + 1}

    _try_restore_session()
    try:
        cl = _require_client()
        # Jitter before the call, not after: a request every 25.000s is a more
        # obvious machine than one every 25-40s.
        _time.sleep(_random.uniform(0.4, 2.5))
        _state["last_media_at"] = _time.time()

        pk = cl.media_pk_from_code(shortcode)
        media = cl.media_info(pk)
        item = _media_to_item(media, "lookup")
        item["ok"] = True
        return item
    except LoginRequired:
        _mark_session_expired("LoginRequired")
        return {"error": "login_required"}
    except (PleaseWaitFewMinutes, ClientThrottledError) as e:
        # Instagram asked us to stop. Stopping for hours is cheaper than losing
        # the account, so this is a hard cooldown, not a short retry.
        _enter_cooldown(f"media lookup throttled: {type(e).__name__}")
        return {"error": "cooldown", "retry_in_s": int(COOLDOWN_S),
                "reason": f"{type(e).__name__}"}
    except (ChallengeRequired, ChallengeUnknownStep) as e:
        _enter_cooldown(f"challenge during media lookup: {type(e).__name__}")
        return {"error": "challenge", "detail": "Instagram raised a security challenge."}
    except Exception as e:  # noqa: BLE001
        # A deleted or private reel is a permanent condition, not a transient
        # failure — flagged separately so the caller stops paying rate limit to
        # re-request links that will never resolve.
        text = f"{type(e).__name__}: {e}".lower()
        if "not found" in text or "media_not_found" in text or "unavailable" in text:
            return {"error": "unavailable", "detail": "Media unavailable."}
        return {"error": "lookup_failed", "detail": "Media lookup failed."}


@app.get("/collections")
def collections() -> dict[str, Any]:
    _try_restore_session()
    try:
        cl = _require_client()
        cols = cl.collections()
        return {"collections": [
            {"pk": str(c.id), "name": c.name, "type": getattr(c, "type", None),
             "media_count": getattr(c, "media_count", None)} for c in cols]}
    except LoginRequired:
        return {"error": "login_required"}
    except Exception:  # noqa: BLE001
        return {"error": "lookup_failed"}


@app.get("/threads")
def threads(amount: int = 50, box: str = "") -> dict[str, Any]:
    _try_restore_session()
    try:
        cl = _require_client()
        ts = cl.direct_threads(amount=amount, selected_filter="", box=box or "")
        out = []
        for t in ts:
            users = [u.username for u in (t.users or [])]
            users_detail = [
                {"id": str(u.pk), "username": u.username}
                for u in (t.users or [])
            ]
            out.append({
                "thread_id": str(t.id),
                "title": t.thread_title or (", ".join(users) if users else "Conversation"),
                "users": users,
                "users_detail": users_detail,
                "last_activity_at": _to_iso(getattr(t, "last_activity_at", None)),
                "is_group": getattr(t, "is_group", False),
            })
        return {"threads": out}
    except LoginRequired:
        return {"error": "login_required"}
    except Exception:  # noqa: BLE001
        return {"error": "lookup_failed"}


def _extract_share(m: Any) -> tuple[str, Optional[str], Optional[str], Optional[str], dict[str, Any]]:
    """Return (kind, url_or_text, title, preview_url, media).

    `media` carries what a shared reel actually needs to be watchable later:
    the video file, a thumbnail, and the ORIGINAL poster's handle (not the
    person who forwarded it). Dropping these is why every DM-shared reel in
    the vault was an unplayable link with "Shared by 1000000000" as its title.
    """
    for attr in ("media_share", "clip"):
        shared = getattr(m, attr, None)
        if not shared:
            continue
        user = getattr(shared, "user", None)
        return (
            "media",
            _build_permalink(shared),
            getattr(shared, "caption_text", None),
            str(getattr(shared, "thumbnail_url", "") or "") or None,
            {
                "video_url": str(getattr(shared, "video_url", "") or "") or None,
                "thumbnail_url": str(getattr(shared, "thumbnail_url", "") or "") or None,
                "author": getattr(user, "username", None) if user else None,
                "taken_at": _to_iso(getattr(shared, "taken_at", None)),
            },
        )
    xma = getattr(m, "xma_share", None)
    if xma:
        video = str(getattr(xma, "video_url", "") or "") or None
        preview = str(getattr(xma, "preview_url", "") or "") or None
        return ("xma", video, getattr(xma, "title", None), preview,
                {"video_url": video, "thumbnail_url": preview, "author": None, "taken_at": None})
    link = getattr(m, "link", None)
    if link:
        url = None
        lc = getattr(link, "link_context", None)
        if lc:
            url = getattr(lc, "link_url", None)
        return ("link", url, getattr(lc, "link_title", None) if lc else None, None, {})
    if getattr(m, "text", None):
        return ("text", m.text, None, None, {})
    return ("raw", None, None, None, {})


def _run_gather(job_id: str, req: GatherReq) -> None:
    job = _jobs[job_id]
    lo = _parse_bound(req.date_from)
    hi = _parse_bound(req.date_to)
    items: list[dict[str, Any]] = []
    # Expose the SAME list reference live so callers can read partial results
    # and store them incrementally while a long gather is still running.
    job["items"] = items
    stats = {"saved": 0, "reels": 0, "dms": 0, "articles": 0, "skipped_sparse": 0}
    seen_urls: set[str] = set()
    try:
        cl = _require_client()
        want_saved = "saved" in req.content_types
        want_reels = "reels" in req.content_types
        want_dms = "dms" in req.content_types
        want_articles = "articles" in req.content_types

        # --- saved + reels (one pass over collections) ---
        if want_saved or want_reels:
            job["progress"] = "reading saved collections"
            col_pks = list(req.collection_pks)
            if not col_pks:
                try:
                    col_pks = [str(c.id) for c in cl.collections()]
                except Exception as e:  # noqa: BLE001
                    job.setdefault("col_errors", []).append(f"collections(): {type(e).__name__}: {e}")
            # The default "All Posts" saved feed is the auto collection; its id is
            # the non-numeric "ALL_MEDIA_AUTO_COLLECTION" and collections() does not
            # always list it. Include it explicitly, and NEVER int()-cast pks (that
            # crash on the auto id was silently dropping the entire saved feed).
            if "ALL_MEDIA_AUTO_COLLECTION" not in col_pks:
                col_pks.insert(0, "ALL_MEDIA_AUTO_COLLECTION")
            for pk in col_pks:
                cpk: Any = int(pk) if str(pk).isdigit() else pk
                try:
                    medias = cl.collection_medias(cpk, amount=0)
                except Exception as e:  # noqa: BLE001
                    job.setdefault("col_errors", []).append(f"{pk}: {type(e).__name__}: {e}")
                    continue
                for media in medias:
                    if not _in_range(getattr(media, "taken_at", None), lo, hi):
                        continue
                    kind = _classify(media)
                    if kind == "reel" and not want_reels:
                        continue
                    if kind == "post" and not want_saved:
                        continue
                    item = _media_to_item(media, source=f"collection:{pk}")
                    items.append(item)
                    stats["reels" if kind == "reel" else "saved"] += 1
                    job["count"] = len(items)

        # --- dms + articles ---
        if want_dms or want_articles:
            job["progress"] = "reading direct messages"
            thread_list = []
            if req.thread_ids:
                thread_list = [{"id": tid} for tid in req.thread_ids]
            else:
                # Both inboxes: message *requests* live in the "pending" box and
                # were previously skipped entirely, so anything shared by someone
                # you have not replied to never reached the vault.
                seen_tids: set[str] = set()
                for box in ("", "pending"):
                    try:
                        found = cl.direct_threads(
                            amount=req.thread_limit, selected_filter="", box=box)
                    except Exception as e:  # noqa: BLE001
                        job.setdefault("thread_errors", []).append(f"box={box or 'primary'}: {type(e).__name__}: {e}")
                        continue
                    for t in found:
                        tid = str(t.id)
                        if tid in seen_tids:
                            continue
                        seen_tids.add(tid)
                        if lo and getattr(t, "last_activity_at", None) and _to_iso(t.last_activity_at) < (lo.isoformat()):
                            continue
                        thread_list.append({
                            "id": tid, "title": t.thread_title,
                            "users": [u.username for u in (t.users or [])],
                            # id -> handle, so a share is attributed to a person
                            # rather than to a bare numeric user id.
                            "user_names": {str(u.pk): u.username for u in (t.users or [])},
                        })
                job["thread_count"] = len(thread_list)
            for th in thread_list:
                tid = th["id"]
                try:
                    msgs = cl.direct_messages(int(tid), amount=req.thread_message_limit)
                except Exception:
                    continue
                for m in msgs:
                    ts = getattr(m, "timestamp", None)
                    if not _in_range(ts, lo, hi):
                        continue
                    kind, val, title, preview, media = _extract_share(m)
                    sender = str(getattr(m, "user_id", "") or "")
                    if req.sender_ids and sender not in req.sender_ids:
                        continue
                    sender_name = (th.get("user_names") or {}).get(sender) or sender
                    if want_dms and kind in ("media", "xma", "text", "link"):
                        items.append({
                            "type": "dm_share" if kind in ("media", "xma") else ("dm_link" if kind == "link" else "dm_text"),
                            "thread_id": str(tid), "thread_title": th.get("title"),
                            "from": sender_name, "from_id": sender, "timestamp": _to_iso(ts),
                            "share_kind": kind, "permalink": val if kind in ("media", "xma", "link") else None,
                            "text": val if kind == "text" else None,
                            "title": title, "preview_url": preview,
                            # What makes a shared reel playable and attributable.
                            "video_url": media.get("video_url"),
                            "thumbnail_url": media.get("thumbnail_url"),
                            "author": media.get("author"),
                            "taken_at": media.get("taken_at"),
                        })
                        stats["dms"] += 1
                    if want_articles:
                        urls: list[str] = []
                        if kind == "link" and val:
                            urls.append(val)
                        if kind == "text" and val:
                            urls += URL_RE.findall(val)
                        for u in urls:
                            if u in seen_urls:
                                continue
                            seen_urls.add(u)
                            items.append({"type": "article", "url": u, "ig_title": title or "",
                                          "source": f"dm:{tid}", "timestamp": _to_iso(ts)})
                            stats["articles"] += 1
                job["count"] = len(items)

        job["status"] = "done"
        job["stats"] = stats
        job["items"] = items
        job["progress"] = "complete"
    except LoginRequired:
        # The session died mid-gather. Drop the dead client so /health reports
        # "expired" and the app can ask for a fresh session id.
        _mark_session_expired("LoginRequired")
        job["status"] = "error"
        job["error"] = "login_required"
    except (PleaseWaitFewMinutes, ClientThrottledError) as e:
        # Never retry into a throttle: park the bridge for COOLDOWN_S.
        _enter_cooldown(f"rate_limited: {e}")
        job["status"] = "error"
        job["error"] = "rate_limited_cooldown"
    except ChallengeRequired:
        _enter_cooldown("challenge_required")
        job["status"] = "error"
        job["error"] = "challenge_required_cooldown"
        job["detail"] = "Instagram raised a security challenge. Resolve it in the Instagram app; the bridge will refuse requests for a while."
    except Exception:  # noqa: BLE001
        job["status"] = "error"
        job["error"] = "gather_failed"
        # Keep the traceback server-side only (never returned by /gather/{id}).
        job["trace"] = traceback.format_exc()


@app.post("/gather")
def gather(req: GatherReq) -> dict[str, Any]:
    import time as _time
    _try_restore_session()
    if _state["client"] is None:
        return {"error": "login_required"}
    now = _time.time()
    if now < _state["cooldown_until"]:
        return {"error": "cooling_down",
                "reason": _state.get("cooldown_reason"),
                "retry_after_s": int(_state["cooldown_until"] - now)}
    if not req.force and (now - _state["last_gather_at"]) < MIN_GATHER_INTERVAL_S:
        return {"error": "too_soon",
                "detail": f"Last sync was {int((now - _state['last_gather_at']) / 3600)}h ago; "
                          f"minimum interval is {int(MIN_GATHER_INTERVAL_S / 3600)}h. Pass force=true to override.",
                "retry_after_s": int(MIN_GATHER_INTERVAL_S - (now - _state["last_gather_at"]))}
    _state["last_gather_at"] = now
    job_id = uuid.uuid4().hex
    _jobs[job_id] = {"status": "running", "progress": "starting", "count": 0,
                     "stats": {}, "items": [], "error": None}
    threading.Thread(target=_run_gather, args=(job_id, req), daemon=True).start()
    return {"job_id": job_id}


@app.get("/gather/{job_id}")
def gather_status(job_id: str) -> dict[str, Any]:
    job = _jobs.get(job_id)
    if not job:
        return {"error": "unknown_job"}
    # Always return a snapshot of items found so far so the caller can store
    # them incrementally and the vault fills up live during a long gather.
    items = list(job.get("items") or [])
    return {"status": job["status"], "progress": job["progress"], "count": job["count"],
            "stats": job["stats"], "error": job["error"], "items": items}


class ConvertReq(BaseModel):
    url: str


def _safe_fetch_bytes(url: str, max_bytes: int = 2_000_000, max_hops: int = 5) -> bytes:
    """Fetch a public URL pinned to a validated IP; re-validate every redirect hop."""
    current = url
    for _ in range(max_hops):
        if not _public_http_url(current):
            raise ValueError("url_not_allowed")
        parsed = urlparse(current)
        assert parsed.hostname is not None
        ips = _resolve_public_ips(parsed.hostname)
        if not ips:
            raise ValueError("url_not_allowed")
        pinned_ip = next((ip for ip in ips if ":" not in ip), ips[0])
        pinned_url, host_header = _url_with_pinned_ip(current, pinned_ip)
        session = requests.Session()
        if parsed.scheme == "https":
            session.mount("https://", _PinnedIPAdapter(parsed.hostname))
        try:
            with session.get(
                pinned_url,
                allow_redirects=False,
                timeout=20,
                stream=True,
                headers={
                    "User-Agent": "ReelVault-bridge/1.0",
                    "Host": host_header,
                },
            ) as resp:
                if resp.is_redirect or resp.status_code in (301, 302, 303, 307, 308):
                    loc = resp.headers.get("Location")
                    if not loc:
                        raise ValueError("bad_redirect")
                    current = urljoin(current, loc)
                    continue
                resp.raise_for_status()
                chunks: list[bytes] = []
                total = 0
                for block in resp.iter_content(64 * 1024):
                    if not block:
                        continue
                    total += len(block)
                    if total > max_bytes:
                        raise ValueError("body_too_large")
                    chunks.append(block)
                return b"".join(chunks)
        finally:
            session.close()
    raise ValueError("too_many_redirects")


@app.post("/convert")
def convert(req: ConvertReq) -> dict[str, Any]:
    """Convert a public http(s) URL to Markdown via markitdown.

    Uses Microsoft markitdown (https://github.com/microsoft/markitdown).
    markitdown is imported lazily so the service boots even if it is missing.
    Markdown is truncated to ~8 000 chars to keep response payloads sane.
    Local paths and private IPs are rejected (SSRF / file-read defense).
    Content is fetched with redirect revalidation so MarkItDown never follows
    an unchecked hop to loopback/metadata.
    """
    if not _public_http_url(req.url):
        return {"ok": False, "error": "url_not_allowed"}
    try:
        from markitdown import MarkItDown  # type: ignore[import]
    except ImportError:
        return {"ok": False, "error": "markitdown_not_installed"}
    tmp_path: Optional[str] = None
    try:
        raw = _safe_fetch_bytes(req.url)
        # Write bytes we fetched ourselves; never pass an attacker path to MarkItDown.
        with tempfile.NamedTemporaryFile(suffix=".html", delete=False) as tmp:
            tmp.write(raw)
            tmp_path = tmp.name
        md = MarkItDown()
        result = md.convert(tmp_path)
        text = result.text_content or ""
        if len(text) > 8000:
            text = text[:8000]
        return {"ok": True, "markdown": text}
    except ValueError as e:
        if str(e) == "url_not_allowed":
            return {"ok": False, "error": "url_not_allowed"}
        return {"ok": False, "error": "convert_failed"}
    except (OSError, requests.RequestException):
        return {"ok": False, "error": "convert_failed"}
    except Exception:  # noqa: BLE001
        return {"ok": False, "error": "convert_failed"}
    finally:
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
