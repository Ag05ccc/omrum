from __future__ import annotations
from Xlib import display
from Xlib.ext import screensaver  # noqa: F401  registers extension


class X11IdleProbe:
    def __init__(self) -> None:
        self._d = display.Display()
        self._root = self._d.screen().root
        if not self._d.has_extension("MIT-SCREEN-SAVER"):
            raise RuntimeError("X server lacks MIT-SCREEN-SAVER extension")

    def idle_seconds(self) -> float:
        info = self._root.screensaver_query_info()
        return info.idle / 1000.0
