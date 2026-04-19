from __future__ import annotations
import argparse
import logging
import os
import signal
import sys
import threading

from . import config, install, server, storage, tracker


def _run_daemon(args: argparse.Namespace) -> int:
    storage.init()
    stop = threading.Event()
    restart = threading.Event()

    def _sig(_signum, _frame) -> None:
        stop.set()

    signal.signal(signal.SIGINT, _sig)
    signal.signal(signal.SIGTERM, _sig)

    threads: list[threading.Thread] = []
    if not args.no_server:
        t = threading.Thread(target=server.serve_forever, args=(stop, restart),
                             name="http", daemon=True)
        t.start()
        threads.append(t)

    if not args.no_tracker:
        t = threading.Thread(target=tracker.run_forever, args=(stop,), name="tracker", daemon=True)
        t.start()
        threads.append(t)

    try:
        if args.no_tray:
            while not stop.is_set():
                stop.wait(1.0)
        else:
            # Import here so --no-tray paths don't require Pillow/pystray deps at import time.
            from . import tray
            try:
                tray.run(stop, restart_event=restart)
            except Exception as e:
                logging.warning("tray unavailable (%s); falling back to headless", e)
                while not stop.is_set():
                    stop.wait(1.0)
    finally:
        stop.set()
        for t in threads:
            t.join(timeout=3.0)

    if restart.is_set():
        # Replace the current process with a fresh one, preserving the same
        # flags the user launched with. Works whether we were started as the
        # `omrum` console script or via `python -m omrum`.
        logging.info("restarting daemon…")
        os.execv(sys.executable, [sys.executable, "-m", "omrum", *sys.argv[1:]])
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(prog="omrum", description="Local desktop time tracker")
    parser.add_argument(
        "command",
        nargs="?",
        default="run",
        choices=["run", "install", "uninstall"],
        help="run the daemon (default), or (un)install autostart + app launcher",
    )
    parser.add_argument("--verbose", "-v", action="store_true")
    parser.add_argument("--no-server", action="store_true", help="skip the dashboard HTTP server")
    parser.add_argument("--no-tracker", action="store_true", help="skip the active-window tracker")
    parser.add_argument("--no-tray", action="store_true", help="skip the system tray icon")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    if args.command == "install":
        install.install()
        return 0
    if args.command == "uninstall":
        install.uninstall()
        return 0
    return _run_daemon(args)


if __name__ == "__main__":
    raise SystemExit(main())
