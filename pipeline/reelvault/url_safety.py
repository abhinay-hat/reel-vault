"""Public-HTTP URL checks for pipeline downloads (SSRF defense).

Resolve once, validate every address, connect only to a validated IP
(with Host/SNI preserved), and re-validate each redirect hop.
"""
from __future__ import annotations

import ipaddress
import socket
from typing import Callable
from urllib.parse import urljoin, urlparse, urlunparse

import requests
from requests.adapters import HTTPAdapter

_BLOCKED_HOSTS = {"localhost", "metadata.google.internal"}

ResolveFn = Callable[[str], list[tuple[str, int]]]


def is_private_ip(ip: str) -> bool:
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


def _default_resolve(host: str) -> list[tuple[str, int]]:
    infos = socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
    out: list[tuple[str, int]] = []
    seen: set[str] = set()
    for info in infos:
        ip = info[4][0]
        if ip in seen:
            continue
        seen.add(ip)
        family = 6 if ":" in ip else 4
        out.append((ip, family))
    return out


def resolve_public_addresses(
    host: str,
    resolve: ResolveFn | None = None,
) -> list[tuple[str, int]]:
    """Return validated public addresses for host; raise ValueError otherwise."""
    resolve = resolve or _default_resolve
    try:
        ipaddress.ip_address(host)
    except ValueError:
        pass
    else:
        if is_private_ip(host):
            raise ValueError("url_not_allowed")
        return [(host, 6 if ":" in host else 4)]
    try:
        addrs = resolve(host)
    except OSError as e:
        raise ValueError("url_not_allowed") from e
    if not addrs or any(is_private_ip(ip) for ip, _ in addrs):
        raise ValueError("url_not_allowed")
    return addrs


def assert_public_http_url(url: str, resolve: ResolveFn | None = None) -> None:
    if not url or url.startswith("/") or url.startswith("\\") or "://" not in url:
        raise ValueError("url_not_allowed")
    try:
        u = urlparse(url)
    except Exception as e:  # noqa: BLE001
        raise ValueError("url_not_allowed") from e
    if u.scheme not in ("http", "https"):
        raise ValueError("url_not_allowed")
    if u.username or u.password or not u.hostname:
        raise ValueError("url_not_allowed")
    host = u.hostname.lower()
    if host in _BLOCKED_HOSTS:
        raise ValueError("url_not_allowed")
    resolve_public_addresses(host, resolve)


class _PinnedIPAdapter(HTTPAdapter):
    """HTTPS adapter that keeps SNI/cert hostname when the URL uses a literal IP."""

    def __init__(self, server_hostname: str, **kwargs):
        self._server_hostname = server_hostname
        super().__init__(**kwargs)

    def init_poolmanager(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        kwargs["server_hostname"] = self._server_hostname
        kwargs["assert_hostname"] = self._server_hostname
        return super().init_poolmanager(*args, **kwargs)


def _url_with_pinned_ip(url: str, ip: str) -> tuple[str, str]:
    """Rewrite URL netloc to the pinned IP; return (pinned_url, Host header value)."""
    u = urlparse(url)
    assert u.hostname is not None
    host_header = u.hostname
    if u.port:
        host_header = f"{u.hostname}:{u.port}"
    if ":" in ip:
        netloc = f"[{ip}]"
    else:
        netloc = ip
    if u.port:
        netloc = f"{netloc}:{u.port}"
    pinned = urlunparse((u.scheme, netloc, u.path or "", u.params, u.query, u.fragment))
    return pinned, host_header


def safe_get(
    url: str,
    *,
    timeout: float = 120,
    headers: dict[str, str] | None = None,
    max_hops: int = 5,
    resolve: ResolveFn | None = None,
) -> requests.Response:
    """GET with DNS pin + redirect revalidation; raises ValueError on non-public hops."""
    current = url
    last: requests.Response | None = None
    for _ in range(max_hops):
        assert_public_http_url(current, resolve=resolve)
        u = urlparse(current)
        assert u.hostname is not None
        addrs = resolve_public_addresses(u.hostname, resolve)
        pinned_ip = next((ip for ip, fam in addrs if fam == 4), addrs[0][0])
        pinned_url, host_header = _url_with_pinned_ip(current, pinned_ip)

        session = requests.Session()
        if u.scheme == "https" and u.hostname:
            session.mount("https://", _PinnedIPAdapter(u.hostname))
        req_headers = dict(headers or {})
        req_headers["Host"] = host_header
        try:
            last = session.get(
                pinned_url,
                allow_redirects=False,
                timeout=timeout,
                stream=True,
                headers=req_headers,
            )
        finally:
            session.close()

        if last.is_redirect or last.status_code in (301, 302, 303, 307, 308):
            loc = last.headers.get("Location")
            last.close()
            if not loc:
                raise ValueError("bad_redirect")
            # Resolve relative redirects against the original (hostname) URL, not the IP URL.
            current = urljoin(current, loc)
            continue
        last.raise_for_status()
        return last
    raise ValueError("too_many_redirects")
