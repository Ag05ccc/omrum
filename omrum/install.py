from __future__ import annotations
import shutil
import sys
from pathlib import Path

from .tray import make_icon

HOME = Path.home()
AUTOSTART_PATH = HOME / ".config" / "autostart" / "omrum.desktop"
APPLICATIONS_PATH = HOME / ".local" / "share" / "applications" / "omrum.desktop"
ICON_DIR = HOME / ".local" / "share" / "icons" / "hicolor" / "256x256" / "apps"
ICON_PATH = ICON_DIR / "omrum.png"

_DESKTOP_TEMPLATE = """[Desktop Entry]
Type=Application
Version=1.0
Name=Omrum
GenericName=Time Tracker
Comment=Local-first desktop time tracker
Exec={exec_path}
Icon=omrum
Terminal=false
StartupNotify=false
Categories=Utility;Monitor;Office;
Keywords=time;tracker;productivity;
X-GNOME-Autostart-enabled=true
"""


def _resolve_exec() -> str:
    # Prefer the installed `omrum` console script so the system doesn't
    # need to know about the venv's python interpreter.
    path = shutil.which("omrum")
    if path:
        return path
    # Fallback: current interpreter + module invocation.
    return f"{sys.executable} -m omrum"


def install() -> None:
    exec_path = _resolve_exec()
    for p in (AUTOSTART_PATH.parent, APPLICATIONS_PATH.parent, ICON_DIR):
        p.mkdir(parents=True, exist_ok=True)
    icon = make_icon(256)
    icon.save(ICON_PATH, "PNG")
    content = _DESKTOP_TEMPLATE.format(exec_path=exec_path)
    AUTOSTART_PATH.write_text(content)
    APPLICATIONS_PATH.write_text(content)
    for p in (AUTOSTART_PATH, APPLICATIONS_PATH):
        p.chmod(0o644)
    print(f"Wrote autostart entry:  {AUTOSTART_PATH}")
    print(f"Wrote application entry:{APPLICATIONS_PATH}")
    print(f"Wrote icon:              {ICON_PATH}")
    print(f"Exec: {exec_path}")
    print("")
    print("Omrum will start automatically on next login.")
    print("To start it now without logging out:  omrum &")
    print("To remove autostart:                  omrum uninstall")


def uninstall() -> None:
    removed = 0
    for p in (AUTOSTART_PATH, APPLICATIONS_PATH, ICON_PATH):
        if p.exists():
            p.unlink()
            print(f"Removed: {p}")
            removed += 1
    if removed == 0:
        print("Nothing to remove.")
