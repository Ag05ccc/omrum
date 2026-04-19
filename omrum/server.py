from __future__ import annotations
import json
import logging
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib.resources import files as resource_files
from typing import Any

from . import browser_state, config, periods, storage

log = logging.getLogger("omrum.server")


def _read_web(name: str) -> bytes:
    return (resource_files("omrum.web") / name).read_bytes()


class Handler(BaseHTTPRequestHandler):
    server_version = "omrum/0.1"

    def log_message(self, fmt: str, *args: Any) -> None:  # quieter default
        log.debug("%s - " + fmt, self.address_string(), *args)

    # CORS for the browser extension
    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json(self, code: int, body: Any) -> None:
        payload = json.dumps(body).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self._cors()
        self.end_headers()
        self.wfile.write(payload)

    def _static(self, name: str, ctype: str) -> None:
        try:
            data = _read_web(name)
        except FileNotFoundError:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self) -> None:
        path = self.path.split("?", 1)[0]
        qs = dict(
            kv.split("=", 1) if "=" in kv else (kv, "")
            for kv in (self.path.split("?", 1)[1].split("&") if "?" in self.path else [])
            if kv
        )
        if path == "/" or path == "/index.html":
            self._static("index.html", "text/html; charset=utf-8")
        elif path == "/app.js":
            self._static("app.js", "application/javascript; charset=utf-8")
        elif path == "/style.css":
            self._static("style.css", "text/css; charset=utf-8")
        elif path == "/api/health":
            self._json(200, {"ok": True, "time": time.time()})
        elif path == "/api/labels":
            self._json(200, {"labels": storage.list_labels(), "rules": storage.list_rules()})
        elif path == "/api/settings":
            self._json(200, {
                "idle_threshold_s": storage.get_setting_float(
                    "idle_threshold_s", config.IDLE_THRESHOLD_S),
                "idle_threshold_default_s": config.IDLE_THRESHOLD_S,
                "poll_interval_s": config.POLL_INTERVAL_S,
                "http_port": config.HTTP_PORT,
                "http_host": config.HTTP_HOST,
                "data_dir": str(config.DATA_DIR),
            })
        elif path == "/api/summary":
            # back-compat: accept legacy ?date=YYYY-MM-DD as day-period anchor
            anchor = qs.get("anchor") or qs.get("date")
            win = periods.resolve(
                qs.get("period"),
                anchor=anchor,
                start=qs.get("start"),
                end=qs.get("end"),
            )
            labels = storage.list_labels()
            rules = storage.list_rules()
            rule_map = {(r["target_type"], r["target"]): r["label_id"] for r in rules}
            label_map = {lb["id"]: lb for lb in labels}

            def _attach(items, name_key):
                tt = "domain" if name_key == "domain" else "app"
                for it in items:
                    lid = rule_map.get((tt, it[name_key]))
                    it["assigned"] = label_map.get(lid) if lid else None
                return items

            activity = storage.summary_activity(win.start_ts, win.end_ts)
            for it in activity:
                tt = "domain" if it["kind"] == "web" else "app"
                lid = rule_map.get((tt, it["label"]))
                it["assigned"] = label_map.get(lid) if lid else None

            # Pick a timeline bucket that renders nicely across periods.
            span = max(1.0, win.end_ts - win.start_ts)
            if span <= 36 * 3600:           # day → 1h bars
                bucket_s = 3600.0
            elif span <= 10 * 86400:        # week/short range → 4h bars
                bucket_s = 4 * 3600.0
            else:                            # month/year/range → 1 day bars
                bucket_s = 86400.0
            timeline = storage.summary_timeline(win.start_ts, win.end_ts, bucket_s)

            # Derived productivity stats.
            p_total = sum(b["productive"] for b in timeline)
            u_total = sum(b["unproductive"] for b in timeline)
            n_total = sum(b["neutral"] for b in timeline)
            i_total = sum(b["idle"] for b in timeline)
            effective_base = p_total + u_total
            effectiveness = (p_total / effective_base) if effective_base > 0 else 0.0
            tracked = p_total + u_total + n_total + sum(b["unlabeled"] for b in timeline)
            productivity = (p_total / tracked) if tracked > 0 else 0.0
            peak = None
            if timeline:
                pk = max(timeline, key=lambda b: b["productive"])
                if pk["productive"] > 0:
                    peak = {"t": pk["t"], "productive": pk["productive"],
                            "bucket_s": bucket_s}

            self._json(200, {
                "window": {
                    "period": win.period,
                    "anchor": win.anchor,
                    "label": win.label,
                    "start": win.start_ts,
                    "end": win.end_ts,
                    "prev": win.prev_anchor,
                    "next": win.next_anchor,
                },
                "totals": storage.totals(win.start_ts, win.end_ts),
                "activity": activity,
                "apps": _attach(storage.summary_by_app(win.start_ts, win.end_ts), "app"),
                "domains": _attach(storage.summary_by_domain(win.start_ts, win.end_ts), "domain"),
                "by_label": storage.summary_by_label(win.start_ts, win.end_ts),
                "timeline": {"bucket_s": bucket_s, "buckets": timeline},
                "stats": {
                    "productive_seconds": p_total,
                    "unproductive_seconds": u_total,
                    "neutral_seconds": n_total,
                    "idle_seconds": i_total,
                    "effectiveness": effectiveness,
                    "productivity": productivity,
                    "peak": peak,
                },
            })
        else:
            self.send_error(404)

    def do_POST(self) -> None:
        path = self.path.split("?", 1)[0]
        length = int(self.headers.get("Content-Length", "0") or 0)
        raw = self.rfile.read(length) if length > 0 else b""
        try:
            body = json.loads(raw.decode("utf-8")) if raw else {}
        except Exception:
            return self._json(400, {"error": "invalid_json"})

        if path == "/api/browser":
            url = (body.get("url") or "").strip()
            title = (body.get("title") or "").strip()
            if not url or not url.startswith(("http://", "https://")):
                browser_state.clear()
                return self._json(200, {"ok": True, "cleared": True})
            browser_state.update(url, title)
            return self._json(200, {"ok": True})

        if path == "/api/labels":
            name = (body.get("name") or "").strip()
            color = (body.get("color") or "#888").strip()
            if not name:
                return self._json(400, {"error": "name required"})
            try:
                lb = storage.create_label(name, color)
            except Exception as e:
                return self._json(400, {"error": str(e)})
            return self._json(200, lb)

        if path == "/api/settings":
            idle = body.get("idle_threshold_s")
            if idle is None:
                return self._json(400, {"error": "idle_threshold_s required"})
            try:
                idle_f = float(idle)
            except (TypeError, ValueError):
                return self._json(400, {"error": "idle_threshold_s must be a number"})
            if idle_f < 10:
                return self._json(400, {"error": "idle_threshold_s must be >= 10 seconds"})
            if idle_f > 86400:
                return self._json(400, {"error": "idle_threshold_s must be <= 86400 (24h)"})
            storage.set_setting("idle_threshold_s", idle_f)
            return self._json(200, {"ok": True, "idle_threshold_s": idle_f})

        if path == "/api/assign":
            target_type = body.get("target_type")
            target = (body.get("target") or "").strip()
            label_id = body.get("label_id")  # may be None to clear
            if target_type not in ("app", "domain") or not target:
                return self._json(400, {"error": "target_type and target required"})
            try:
                storage.set_rule(target_type, target, label_id)
            except Exception as e:
                return self._json(400, {"error": str(e)})
            return self._json(200, {"ok": True})

        if path == "/api/import":
            events = body.get("events") or []
            apply_label = (body.get("apply_label") or "").strip() or None
            if not isinstance(events, list) or not events:
                return self._json(400, {"error": "events must be a non-empty list"})
            try:
                result = storage.import_events(events, apply_label_name=apply_label,
                                               title_tag=body.get("title_tag") or "[import]")
            except Exception as e:
                return self._json(400, {"error": str(e)})
            return self._json(200, {"ok": True, **result})

        if path == "/api/restart":
            events = getattr(self.server, "omrum_events", {})
            stop_ev = events.get("stop")
            restart_ev = events.get("restart")
            if stop_ev is None or restart_ev is None:
                return self._json(501, {"error": "restart not supported in this process"})
            restart_ev.set()
            stop_ev.set()
            return self._json(200, {"ok": True, "restarting": True})

        if path == "/api/manual":
            app = (body.get("app") or "").strip()
            domain = (body.get("domain") or "").strip() or None
            seconds = float(body.get("seconds") or 0)
            when_ts = body.get("when_ts")
            if when_ts is None:
                when_ts = time.time() - seconds  # span ends "now" by default
            else:
                when_ts = float(when_ts)
            if seconds <= 0 or (not app and not domain):
                return self._json(400, {"error": "app or domain and seconds>0 required"})
            try:
                rid = storage.insert_manual(app, domain, seconds, when_ts)
            except Exception as e:
                return self._json(400, {"error": str(e)})
            return self._json(200, {"ok": True, "id": rid})

        self.send_error(404)

    def do_DELETE(self) -> None:
        path = self.path.split("?", 1)[0]
        if path.startswith("/api/labels/"):
            try:
                lid = int(path.rsplit("/", 1)[1])
            except ValueError:
                return self._json(400, {"error": "bad id"})
            ok = storage.delete_label(lid)
            return self._json(200 if ok else 404, {"ok": ok})
        if path == "/api/events":
            length = int(self.headers.get("Content-Length", "0") or 0)
            raw = self.rfile.read(length) if length > 0 else b""
            try:
                body = json.loads(raw.decode("utf-8")) if raw else {}
            except Exception:
                return self._json(400, {"error": "invalid_json"})
            app = (body.get("app") or "").strip() or None
            domain = (body.get("domain") or "").strip() or None
            start_ts = body.get("start_ts")
            end_ts = body.get("end_ts")
            if not app and not domain:
                return self._json(400, {"error": "app or domain required"})
            try:
                removed = storage.delete_events(
                    app=app, domain=domain,
                    start_ts=float(start_ts) if start_ts is not None else None,
                    end_ts=float(end_ts) if end_ts is not None else None,
                )
            except Exception as e:
                return self._json(400, {"error": str(e)})
            return self._json(200, {"ok": True, "removed": removed})
        self.send_error(404)

    def do_PATCH(self) -> None:
        path = self.path.split("?", 1)[0]
        length = int(self.headers.get("Content-Length", "0") or 0)
        raw = self.rfile.read(length) if length > 0 else b""
        try:
            body = json.loads(raw.decode("utf-8")) if raw else {}
        except Exception:
            return self._json(400, {"error": "invalid_json"})
        if path.startswith("/api/labels/"):
            try:
                lid = int(path.rsplit("/", 1)[1])
            except ValueError:
                return self._json(400, {"error": "bad id"})
            ok = storage.update_label(lid, body.get("name"), body.get("color"))
            return self._json(200 if ok else 404, {"ok": ok})
        self.send_error(404)


def serve_forever(stop_event: threading.Event,
                  restart_event: threading.Event | None = None) -> None:
    httpd = ThreadingHTTPServer((config.HTTP_HOST, config.HTTP_PORT), Handler)
    httpd.daemon_threads = True
    # Stash the control events on the server so request handlers can set them.
    httpd.omrum_events = {"stop": stop_event, "restart": restart_event}  # type: ignore[attr-defined]
    log.info("serving http://%s:%d", config.HTTP_HOST, config.HTTP_PORT)

    def watch() -> None:
        stop_event.wait()
        httpd.shutdown()

    threading.Thread(target=watch, daemon=True).start()
    try:
        httpd.serve_forever()
    finally:
        httpd.server_close()
