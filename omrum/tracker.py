from __future__ import annotations
import logging
import time
from dataclasses import dataclass
from typing import Optional

from . import browser_state, config, storage
from .idle import X11IdleProbe
from .window_x11 import X11WindowProbe

log = logging.getLogger("omrum.tracker")


@dataclass
class Span:
    start_ts: float
    app: str
    title: str
    url: Optional[str]
    domain: Optional[str]
    idle: bool

    def key(self) -> tuple:
        return (self.app, self.title, self.url or "", self.idle)


def run_forever(stop_event) -> None:
    win = X11WindowProbe()
    try:
        idle = X11IdleProbe()
        have_idle = True
    except Exception as e:
        log.warning("idle detection disabled: %s", e)
        idle = None
        have_idle = False

    current: Optional[Span] = None

    while not stop_event.is_set():
        now = time.time()
        active = win.active()
        idle_s = idle.idle_seconds() if have_idle else 0.0
        is_idle = have_idle and idle_s >= config.IDLE_THRESHOLD_S

        if active is None:
            app, title = "unknown", ""
        else:
            app, title = active["app"], active["title"]

        url: Optional[str] = None
        domain: Optional[str] = None
        if not is_idle and app in config.BROWSER_APPS:
            be = browser_state.get(config.BROWSER_EVENT_TTL_S)
            if be:
                url = be["url"]
                domain = be["domain"] or None

        new_span = Span(
            start_ts=now, app=app, title=title, url=url, domain=domain, idle=is_idle,
        )

        if current is None:
            current = new_span
        elif current.key() != new_span.key():
            storage.insert_event(
                start_ts=current.start_ts, end_ts=now,
                app=current.app, title=current.title,
                url=current.url, domain=current.domain, idle=current.idle,
            )
            current = new_span

        stop_event.wait(config.POLL_INTERVAL_S)

    if current is not None:
        storage.insert_event(
            start_ts=current.start_ts, end_ts=time.time(),
            app=current.app, title=current.title,
            url=current.url, domain=current.domain, idle=current.idle,
        )
