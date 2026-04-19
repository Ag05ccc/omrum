from __future__ import annotations
from typing import Optional, TypedDict

import psutil
from Xlib import X, display
from Xlib.error import BadWindow, XError


class ActiveWindow(TypedDict):
    app: str
    title: str
    pid: Optional[int]


class X11WindowProbe:
    def __init__(self) -> None:
        self._d = display.Display()
        self._root = self._d.screen().root
        self._NET_ACTIVE_WINDOW = self._d.intern_atom("_NET_ACTIVE_WINDOW")
        self._NET_WM_NAME = self._d.intern_atom("_NET_WM_NAME")
        self._NET_WM_PID = self._d.intern_atom("_NET_WM_PID")
        self._WM_NAME = self._d.intern_atom("WM_NAME")

    def active(self) -> Optional[ActiveWindow]:
        try:
            prop = self._root.get_full_property(self._NET_ACTIVE_WINDOW, X.AnyPropertyType)
            if not prop or not prop.value:
                return None
            wid = int(prop.value[0])
            if wid == 0:
                return None
            win = self._d.create_resource_object("window", wid)

            title = ""
            for atom in (self._NET_WM_NAME, self._WM_NAME):
                try:
                    n = win.get_full_property(atom, 0)
                except (BadWindow, XError):
                    n = None
                if n and n.value:
                    raw = n.value
                    title = raw.decode("utf-8", errors="replace") if isinstance(raw, (bytes, bytearray)) else str(raw)
                    break

            pid: Optional[int] = None
            try:
                pid_prop = win.get_full_property(self._NET_WM_PID, X.AnyPropertyType)
                if pid_prop and pid_prop.value:
                    pid = int(pid_prop.value[0])
            except (BadWindow, XError):
                pid = None

            app = _process_name(pid) if pid else "unknown"
            return {"app": app, "title": title, "pid": pid}
        except (BadWindow, XError):
            return None
        except Exception:
            return None


def _process_name(pid: int) -> str:
    try:
        p = psutil.Process(pid)
        name = p.name() or ""
        name = name.lower()
        if name in ("electron", "python", "python3", "node"):
            try:
                cmd = p.cmdline()
                for arg in cmd[1:]:
                    base = arg.rsplit("/", 1)[-1]
                    if base and not base.startswith("-"):
                        return base.lower()
            except Exception:
                pass
        return name or "unknown"
    except Exception:
        return "unknown"
