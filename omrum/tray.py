from __future__ import annotations
import logging
import os
import threading
import webbrowser

from PIL import Image, ImageDraw
import pystray

from . import config

log = logging.getLogger("omrum.tray")


def make_icon(size: int = 128) -> Image.Image:
    """Draw a simple clock-face icon with brand color; no external assets required."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pad = max(4, size // 16)
    # rounded brand square
    d.rounded_rectangle(
        [pad, pad, size - pad, size - pad],
        radius=size // 6,
        fill=(79, 140, 255, 255),
    )
    # clock face
    cx, cy = size // 2, size // 2
    r = (size // 2) - pad - max(3, size // 24)
    w = max(2, size // 32)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=(255, 255, 255, 255), width=w)
    # hour (12) + minute (2) hands
    d.line([(cx, cy), (cx, cy - r + w + 4)], fill=(255, 255, 255, 255), width=w)
    d.line([(cx, cy), (cx + int(r * 0.7), cy - int(r * 0.3))], fill=(255, 255, 255, 255), width=w)
    # center dot
    cd = max(3, size // 20)
    d.ellipse([cx - cd, cy - cd, cx + cd, cy + cd], fill=(255, 255, 255, 255))
    return img


def dashboard_url() -> str:
    return f"http://{config.HTTP_HOST}:{config.HTTP_PORT}/"


def run(stop_event: threading.Event, restart_event: threading.Event | None = None) -> None:
    """Block until stop_event is set or the user chooses Quit/Restart.
    If the user picks "Restart daemon", both `restart_event` and `stop_event`
    are set so the caller can decide to `os.execv` itself after threads join."""
    # Help pystray pick the indicator backend on modern Ubuntu (appindicator
    # extension is what actually renders the icon in the top bar).
    os.environ.setdefault("PYSTRAY_BACKEND", "appindicator")

    icon_image = make_icon(128)
    url = dashboard_url()

    def open_dashboard(icon, item=None):
        try:
            webbrowser.open(url)
        except Exception as e:
            log.warning("could not open browser: %s", e)

    def restart_action(icon, item=None):
        log.info("restart requested from tray")
        if restart_event is not None:
            restart_event.set()
        stop_event.set()
        icon.stop()

    def quit_action(icon, item=None):
        stop_event.set()
        icon.stop()

    menu = pystray.Menu(
        pystray.MenuItem("Open dashboard", open_dashboard, default=True),
        pystray.MenuItem(f"→ {url}", open_dashboard),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Restart daemon", restart_action),
        pystray.MenuItem("Quit", quit_action),
    )
    icon = pystray.Icon("omrum", icon_image, "Omrum — tracking time", menu)

    def watch_stop() -> None:
        stop_event.wait()
        try:
            icon.stop()
        except Exception:
            pass

    threading.Thread(target=watch_stop, daemon=True).start()
    log.info("tray running")
    icon.run()
