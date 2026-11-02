from __future__ import annotations
import http.client
import json
import re
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from importlib.resources import files as resource_files
from pathlib import Path

from omrum import config, server, storage

EVIL = "https://evil.example"
XSS_COLOR = 'red"><img src=x onerror="alert(1)">'


class SecurityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        # Point storage at a temp dir before init() so the real DB is never opened.
        cls.tmp = tempfile.TemporaryDirectory()
        config.DATA_DIR = Path(cls.tmp.name)
        config.DB_PATH = config.DATA_DIR / "omrum.db"
        storage.init()
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.httpd.shutdown()
        cls.httpd.server_close()
        storage._conn.close()
        cls.tmp.cleanup()

    def request(self, method: str, path: str, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            payload = json.dumps(body) if body is not None else None
            conn.request(method, path, payload, headers or {})
            resp = conn.getresponse()
            data = resp.read()
            return resp.status, dict(resp.getheaders()), data
        finally:
            conn.close()

    def self_origin(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def label_names(self) -> list[str]:
        return [lb["name"] for lb in storage.list_labels()]

    # ---------- cross-site reads ----------

    def test_foreign_origin_cannot_read(self) -> None:
        status, headers, data = self.request("GET", "/api/summary", headers={"Origin": EVIL})
        self.assertEqual(status, 403)
        self.assertNotIn("Access-Control-Allow-Origin", headers)
        self.assertNotIn(b"totals", data)

    def test_other_local_origins_are_foreign(self) -> None:
        for origin in (f"http://127.0.0.1:{self.port + 1}", f"http://localhost:{self.port}", "null"):
            with self.subTest(origin=origin):
                status, _, _ = self.request("GET", "/api/labels", headers={"Origin": origin})
                self.assertEqual(status, 403)

    def test_allowed_responses_never_carry_wildcard_cors(self) -> None:
        for headers in ({}, {"Origin": self.self_origin()}):
            with self.subTest(headers=headers):
                status, resp_headers, _ = self.request("GET", "/api/labels", headers=headers)
                self.assertEqual(status, 200)
                self.assertNotIn("Access-Control-Allow-Origin", resp_headers)

    # ---------- cross-site writes ----------

    def test_foreign_origin_cannot_write(self) -> None:
        # text/plain is what a website uses to dodge the CORS preflight.
        headers = {"Origin": EVIL, "Content-Type": "text/plain"}
        writes = [
            ("POST", "/api/labels", {"name": "csrf-label", "color": "#123456"}),
            ("POST", "/api/manual", {"app": "csrf-app", "seconds": 60}),
            ("POST", "/api/restart", {}),
            ("DELETE", "/api/events", {"app": "csrf-app"}),
            ("PATCH", "/api/labels/1", {"name": "csrf-rename"}),
        ]
        for method, path, body in writes:
            with self.subTest(path=path, method=method):
                status, _, _ = self.request(method, path, body, headers)
                self.assertEqual(status, 403)
        names = self.label_names()
        self.assertNotIn("csrf-label", names)
        self.assertNotIn("csrf-rename", names)
        now = 1 << 31
        self.assertEqual(storage.totals(0, now)["total_seconds"], 0.0)

    def test_foreign_preflight_gets_no_cors_approval(self) -> None:
        status, headers, _ = self.request("OPTIONS", "/api/events", headers={"Origin": EVIL})
        self.assertEqual(status, 403)
        self.assertNotIn("Access-Control-Allow-Origin", headers)

    # ---------- DNS rebinding ----------

    def test_foreign_host_is_rejected(self) -> None:
        for path in ("/", "/app.js", "/api/summary"):
            with self.subTest(path=path):
                status, _, _ = self.request("GET", path, headers={"Host": f"evil.example:{self.port}"})
                self.assertEqual(status, 403)

    def test_rebound_host_with_matching_origin_is_rejected(self) -> None:
        # After rebinding, Origin and Host agree, so only the Host check catches it.
        host = f"evil.example:{self.port}"
        status, _, _ = self.request("GET", "/api/summary", headers={"Host": host, "Origin": f"http://{host}"})
        self.assertEqual(status, 403)

    def test_malformed_and_missing_host_are_rejected(self) -> None:
        status, _, _ = self.request("GET", "/api/labels", headers={"Host": "[bad"})
        self.assertEqual(status, 403)
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            conn.putrequest("GET", "/api/labels", skip_host=True)
            conn.endheaders()
            self.assertEqual(conn.getresponse().status, 403)
        finally:
            conn.close()

    def test_localhost_host_is_allowed(self) -> None:
        host = f"localhost:{self.port}"
        status, _, _ = self.request("GET", "/api/labels", headers={"Host": host, "Origin": f"http://{host}"})
        self.assertEqual(status, 200)

    # ---------- legitimate clients keep working ----------

    def test_dashboard_same_origin_write_works(self) -> None:
        status, _, _ = self.request("POST", "/api/labels", {"name": "same-origin", "color": "#123456"},
                                    {"Origin": self.self_origin(), "Content-Type": "application/json"})
        self.assertEqual(status, 200)
        self.assertIn("same-origin", self.label_names())

    def test_scripts_without_origin_still_work(self) -> None:
        status, _, _ = self.request("POST", "/api/labels", {"name": "from-curl", "color": "#654321"})
        self.assertEqual(status, 200)
        self.assertIn("from-curl", self.label_names())

    def test_extensions_can_report_the_active_tab(self) -> None:
        for origin in ("chrome-extension://abcdef", "moz-extension://1234-5678"):
            with self.subTest(origin=origin):
                status, headers, _ = self.request(
                    "POST", "/api/browser", {"url": "https://example.com/", "title": "x"},
                    {"Origin": origin, "Content-Type": "application/json"})
                self.assertEqual(status, 200)
                self.assertEqual(headers.get("Access-Control-Allow-Origin"), origin)
                status, headers, _ = self.request("OPTIONS", "/api/browser", headers={"Origin": origin})
                self.assertEqual(status, 204)
                self.assertEqual(headers.get("Access-Control-Allow-Origin"), origin)

    def test_extensions_are_limited_to_the_browser_endpoint(self) -> None:
        origin = "chrome-extension://abcdef"
        status, headers, _ = self.request("GET", "/api/summary", headers={"Origin": origin})
        self.assertEqual(status, 403)
        self.assertNotIn("Access-Control-Allow-Origin", headers)
        status, _, _ = self.request("POST", "/api/labels", {"name": "ext-label", "color": "#111111"},
                                    {"Origin": origin})
        self.assertEqual(status, 403)
        self.assertNotIn("ext-label", self.label_names())

    def test_websites_cannot_pose_as_extensions(self) -> None:
        status, _, _ = self.request("POST", "/api/browser", {"url": "https://example.com/"},
                                    {"Origin": "https://chrome-extension.evil.example"})
        self.assertEqual(status, 403)

    # ---------- stored XSS through label colors ----------

    def test_create_rejects_non_hex_color(self) -> None:
        status, _, _ = self.request("POST", "/api/labels", {"name": "xss-create", "color": XSS_COLOR})
        self.assertEqual(status, 400)
        self.assertNotIn("xss-create", self.label_names())

    def test_update_rejects_non_hex_color(self) -> None:
        lb = storage.create_label("xss-update", "#abcdef")
        status, _, _ = self.request("PATCH", f"/api/labels/{lb['id']}", {"color": XSS_COLOR})
        self.assertEqual(status, 400)
        stored = next(x for x in storage.list_labels() if x["id"] == lb["id"])
        self.assertEqual(stored["color"], "#abcdef")

    def test_hex_colors_are_accepted(self) -> None:
        for i, color in enumerate(("#abc", "#ABC", "#4ade80")):
            with self.subTest(color=color):
                status, _, _ = self.request("POST", "/api/labels", {"name": f"hex-{i}", "color": color})
                self.assertEqual(status, 200)

    # ---------- response hardening ----------

    def test_dashboard_sends_csp(self) -> None:
        status, headers, _ = self.request("GET", "/")
        self.assertEqual(status, 200)
        csp = headers["Content-Security-Policy"]
        self.assertIn("script-src 'self';", csp)
        self.assertIn("frame-ancestors 'none'", csp)
        self.assertEqual(headers["X-Content-Type-Options"], "nosniff")

    def test_json_is_not_sniffable(self) -> None:
        _, headers, _ = self.request("GET", "/api/labels")
        self.assertEqual(headers["X-Content-Type-Options"], "nosniff")

    def test_dashboard_has_no_inline_handlers(self) -> None:
        # script-src 'self' blocks these, so one slipping in would silently not run.
        for name in ("index.html", "app.js"):
            with self.subTest(name=name):
                text = (resource_files("omrum.web") / name).read_text(encoding="utf-8")
                self.assertIsNone(re.search(r"""\son[a-z]+=["']""", text))


if __name__ == "__main__":
    unittest.main()
