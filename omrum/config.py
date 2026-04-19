from __future__ import annotations
import os
from pathlib import Path

DATA_DIR = Path(os.environ.get("OMRUM_DATA", Path.home() / ".local/share/omrum"))
DB_PATH = DATA_DIR / "omrum.db"

HTTP_HOST = os.environ.get("OMRUM_HOST", "127.0.0.1")
HTTP_PORT = int(os.environ.get("OMRUM_PORT", "7942"))

POLL_INTERVAL_S = float(os.environ.get("OMRUM_POLL", "2.0"))
IDLE_THRESHOLD_S = float(os.environ.get("OMRUM_IDLE", "120"))
BROWSER_EVENT_TTL_S = 5.0

BROWSER_APPS = {
    "firefox", "firefox-bin", "firefox-esr",
    "chrome", "google-chrome", "chromium", "chromium-browser",
    "brave", "brave-browser", "vivaldi-bin", "vivaldi",
    "opera", "msedge", "microsoft-edge",
}


def ensure_data_dir() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
