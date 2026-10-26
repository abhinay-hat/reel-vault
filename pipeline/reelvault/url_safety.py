"""Public-HTTP URL checks for pipeline downloads (SSRF defense)."""
from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urljoin, urlparse

import requests

_BLOCKED_HOSTS = {"localhost", "metadata.google.internal"}


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


def assert_public_http_url(url: str) -> None:
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
    try:
        ipaddress.ip_address(host)
    except ValueError:
        pass  # hostname: check resolved addresses below
    else:
        if is_private_ip(host):
            raise ValueError("url_not_allowed")
        return
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as e:
        raise ValueError("url_not_allowed") from e
    for info in infos:
        if is_private_ip(info[4][0]):
            raise ValueError("url_not_allowed")


def safe_get(
    url: str,
    *,
    timeout: float = 120,
    headers: dict[str, str] | None = None,
    max_hops: int = 5,
) -> requests.Response:
    """GET with redirect revalidation; raises ValueError on non-public hops."""
    current = url
    last: requests.Response | None = None
    for _ in range(max_hops):
        assert_public_http_url(current)
        last = requests.get(
            current,
            allow_redirects=False,
            timeout=timeout,
            stream=True,
            headers=headers or {},
        )
        if last.is_redirect or last.status_code in (301, 302, 303, 307, 308):
            loc = last.headers.get("Location")
            last.close()
            if not loc:
                raise ValueError("bad_redirect")
            current = urljoin(current, loc)
            continue
        last.raise_for_status()
        return last
    raise ValueError("too_many_redirects")
