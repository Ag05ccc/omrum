from __future__ import annotations
import threading
import time
from typing import Optional, TypedDict
from urllib.parse import urlparse


class BrowserEvent(TypedDict):
    url: str
    title: str
    domain: str
    received_at: float


_lock = threading.Lock()
_current: Optional[BrowserEvent] = None


def update(url: str, title: str) -> None:
    global _current
    domain = ""
    try:
        parsed = urlparse(url)
        domain = parsed.hostname or ""
    except Exception:
        domain = ""
    with _lock:
        _current = {"url": url, "title": title, "domain": domain, "received_at": time.time()}


def get(max_age_s: float) -> Optional[BrowserEvent]:
    with _lock:
        if _current is None:
            return None
        if time.time() - _current["received_at"] > max_age_s:
            return None
        return dict(_current)  # type: ignore[return-value]


def clear() -> None:
    global _current
    with _lock:
        _current = None
