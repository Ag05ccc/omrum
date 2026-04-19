from __future__ import annotations
import sqlite3
import threading
from contextlib import contextmanager
from typing import Iterator, Optional

from . import config

_SCHEMA = """
CREATE TABLE IF NOT EXISTS events (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    start_ts  REAL    NOT NULL,
    end_ts    REAL    NOT NULL,
    duration  REAL    NOT NULL,
    app       TEXT    NOT NULL,
    title     TEXT,
    url       TEXT,
    domain    TEXT,
    idle      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_events_start ON events(start_ts);
CREATE INDEX IF NOT EXISTS idx_events_app   ON events(app);
CREATE INDEX IF NOT EXISTS idx_events_domain ON events(domain);

CREATE TABLE IF NOT EXISTS labels (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    name   TEXT NOT NULL UNIQUE,
    color  TEXT NOT NULL DEFAULT '#888'
);
CREATE TABLE IF NOT EXISTS label_rules (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    label_id    INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
    target_type TEXT    NOT NULL CHECK(target_type IN ('app','domain')),
    target      TEXT    NOT NULL,
    UNIQUE(target_type, target)
);
CREATE INDEX IF NOT EXISTS idx_rules_target ON label_rules(target_type, target);
"""

_DEFAULT_LABELS = (
    ("verimli",  "#4ade80"),
    ("genel",    "#9ca3af"),
    ("verimsiz", "#f87171"),
)

# Clip each span's duration to the [start, end) window so long spans straddling
# a boundary only count their in-window portion.
_CLIPPED = "(MIN(end_ts, :end) - MAX(start_ts, :start))"

_lock = threading.Lock()
_conn: Optional[sqlite3.Connection] = None


def init() -> None:
    global _conn
    config.ensure_data_dir()
    _conn = sqlite3.connect(config.DB_PATH, check_same_thread=False, isolation_level=None)
    _conn.execute("PRAGMA journal_mode=WAL")
    _conn.execute("PRAGMA foreign_keys=ON")
    _conn.executescript(_SCHEMA)
    count = _conn.execute("SELECT COUNT(*) FROM labels").fetchone()[0]
    if count == 0:
        _conn.executemany("INSERT INTO labels (name, color) VALUES (?, ?)", _DEFAULT_LABELS)


@contextmanager
def cursor() -> Iterator[sqlite3.Cursor]:
    assert _conn is not None, "storage.init() not called"
    with _lock:
        cur = _conn.cursor()
        try:
            yield cur
        finally:
            cur.close()


def insert_manual(app: str, domain: Optional[str], seconds: float, when_ts: float) -> int:
    """Insert a single manual span; title is tagged '[manual]' so these rows
    are identifiable later. Returns the new row id."""
    if seconds <= 0:
        raise ValueError("seconds must be > 0")
    if not app and not domain:
        raise ValueError("app or domain required")
    app = app or "manual"
    start_ts = when_ts
    end_ts = when_ts + seconds
    with cursor() as cur:
        cur.execute(
            "INSERT INTO events (start_ts, end_ts, duration, app, title, url, domain, idle) "
            "VALUES (?, ?, ?, ?, ?, NULL, ?, 0)",
            (start_ts, end_ts, seconds, app, "[manual]", domain or None),
        )
        return int(cur.lastrowid)


def import_events(events: list[dict], apply_label_name: Optional[str] = None,
                  title_tag: str = "[import]") -> dict:
    """Batch-insert a list of imported events. Each item needs keys
    `app`, `seconds`, `when_ts`, and optionally `title`, `domain`.
    If `apply_label_name` is given, the referenced label is associated with
    every unique `app` (and every unique `domain`) seen in this batch via
    label_rules. Returns {inserted, labeled_targets}.
    """
    if not events:
        return {"inserted": 0, "labeled_targets": 0}
    label_id: Optional[int] = None
    if apply_label_name:
        with cursor() as cur:
            row = cur.execute("SELECT id FROM labels WHERE name = ?", (apply_label_name,)).fetchone()
            if row:
                label_id = int(row[0])
            else:
                cur.execute("INSERT INTO labels (name, color) VALUES (?, ?)",
                            (apply_label_name, "#4ade80"))
                label_id = int(cur.lastrowid)

    inserted = 0
    apps: set[str] = set()
    domains: set[str] = set()
    with cursor() as cur:
        for ev in events:
            app = (ev.get("app") or "").strip() or "manual"
            title = ev.get("title") or title_tag
            domain = (ev.get("domain") or "").strip() or None
            seconds = float(ev.get("seconds") or 0)
            when_ts = float(ev.get("when_ts") or 0)
            if seconds <= 0 or when_ts <= 0:
                continue
            start_ts = when_ts - seconds
            end_ts = when_ts
            cur.execute(
                "INSERT INTO events (start_ts, end_ts, duration, app, title, url, domain, idle) "
                "VALUES (?, ?, ?, ?, ?, NULL, ?, 0)",
                (start_ts, end_ts, seconds, app, title, domain),
            )
            inserted += 1
            apps.add(app)
            if domain:
                domains.add(domain)

        labeled = 0
        if label_id is not None:
            for a in apps:
                cur.execute(
                    "INSERT INTO label_rules (label_id, target_type, target) VALUES (?, 'app', ?) "
                    "ON CONFLICT(target_type, target) DO UPDATE SET label_id = excluded.label_id",
                    (label_id, a),
                )
                labeled += 1
            for d in domains:
                cur.execute(
                    "INSERT INTO label_rules (label_id, target_type, target) VALUES (?, 'domain', ?) "
                    "ON CONFLICT(target_type, target) DO UPDATE SET label_id = excluded.label_id",
                    (label_id, d),
                )
                labeled += 1
    return {"inserted": inserted, "labeled_targets": labeled}


def delete_events(app: Optional[str] = None, domain: Optional[str] = None,
                  start_ts: Optional[float] = None, end_ts: Optional[float] = None) -> int:
    """Delete events matching app and/or domain. At least one of app/domain MUST
    be supplied — otherwise this function refuses the request, so there is no
    code path that wipes the whole table by accident.
    If start_ts/end_ts are given, only events overlapping that window are removed."""
    if not app and not domain:
        raise ValueError("must supply app or domain")
    where: list[str] = []
    params: list = []
    if app:
        where.append("app = ?"); params.append(app)
    if domain:
        where.append("domain = ?"); params.append(domain)
    if start_ts is not None and end_ts is not None:
        where.append("start_ts < ? AND end_ts > ?"); params.extend([end_ts, start_ts])
    with cursor() as cur:
        cur.execute("DELETE FROM events WHERE " + " AND ".join(where), params)
        return cur.rowcount


def insert_event(start_ts: float, end_ts: float, app: str, title: str,
                 url: Optional[str], domain: Optional[str], idle: bool) -> None:
    duration = max(0.0, end_ts - start_ts)
    if duration <= 0:
        return
    with cursor() as cur:
        cur.execute(
            "INSERT INTO events (start_ts, end_ts, duration, app, title, url, domain, idle) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (start_ts, end_ts, duration, app, title, url, domain, 1 if idle else 0),
        )


def _overlap_filter(include_idle: bool) -> str:
    return (
        "WHERE start_ts < :end AND end_ts > :start "
        + ("" if include_idle else "AND idle = 0 ")
    )


def summary_by_app(start_ts: float, end_ts: float, include_idle: bool = False, limit: int = 200):
    q = (
        f"SELECT app, SUM({_CLIPPED}) AS total "
        f"FROM events {_overlap_filter(include_idle)}"
        f"GROUP BY app ORDER BY total DESC LIMIT :limit"
    )
    with cursor() as cur:
        cur.execute(q, {"start": start_ts, "end": end_ts, "limit": limit})
        return [{"app": r[0], "seconds": r[1] or 0.0} for r in cur.fetchall()]


def summary_by_domain(start_ts: float, end_ts: float, include_idle: bool = False, limit: int = 200):
    q = (
        f"SELECT domain, SUM({_CLIPPED}) AS total "
        f"FROM events {_overlap_filter(include_idle)}"
        f"AND domain IS NOT NULL AND domain != '' "
        f"GROUP BY domain ORDER BY total DESC LIMIT :limit"
    )
    with cursor() as cur:
        cur.execute(q, {"start": start_ts, "end": end_ts, "limit": limit})
        return [{"domain": r[0], "seconds": r[1] or 0.0} for r in cur.fetchall()]


def summary_activity(start_ts: float, end_ts: float, include_idle: bool = False, limit: int = 200):
    """URL-aware: browser spans bucket by domain, others by app. Replaces the
    old "apps" view where chrome/firefox would swallow all browser time."""
    q = (
        "SELECT "
        "  CASE WHEN domain IS NOT NULL AND domain != '' THEN domain ELSE app END AS label, "
        "  CASE WHEN domain IS NOT NULL AND domain != '' THEN 'web' ELSE 'app' END AS kind, "
        f" SUM({_CLIPPED}) AS total "
        f"FROM events {_overlap_filter(include_idle)}"
        "GROUP BY label, kind ORDER BY total DESC LIMIT :limit"
    )
    with cursor() as cur:
        cur.execute(q, {"start": start_ts, "end": end_ts, "limit": limit})
        return [{"label": r[0], "kind": r[1], "seconds": r[2] or 0.0} for r in cur.fetchall()]


# ---------- labels ----------

def list_labels():
    with cursor() as cur:
        cur.execute("SELECT id, name, color FROM labels ORDER BY id")
        return [{"id": r[0], "name": r[1], "color": r[2]} for r in cur.fetchall()]


def list_rules():
    with cursor() as cur:
        cur.execute("SELECT id, label_id, target_type, target FROM label_rules ORDER BY id")
        return [{"id": r[0], "label_id": r[1], "target_type": r[2], "target": r[3]}
                for r in cur.fetchall()]


def create_label(name: str, color: str) -> dict:
    with cursor() as cur:
        cur.execute("INSERT INTO labels (name, color) VALUES (?, ?)", (name, color))
        lid = cur.lastrowid
        return {"id": lid, "name": name, "color": color}


def update_label(label_id: int, name: Optional[str], color: Optional[str]) -> bool:
    fields, params = [], []
    if name is not None:
        fields.append("name = ?"); params.append(name)
    if color is not None:
        fields.append("color = ?"); params.append(color)
    if not fields:
        return True
    params.append(label_id)
    with cursor() as cur:
        cur.execute(f"UPDATE labels SET {', '.join(fields)} WHERE id = ?", params)
        return cur.rowcount > 0


def delete_label(label_id: int) -> bool:
    with cursor() as cur:
        cur.execute("DELETE FROM label_rules WHERE label_id = ?", (label_id,))
        cur.execute("DELETE FROM labels WHERE id = ?", (label_id,))
        return cur.rowcount > 0


def set_rule(target_type: str, target: str, label_id: Optional[int]) -> None:
    if target_type not in ("app", "domain"):
        raise ValueError("target_type must be 'app' or 'domain'")
    with cursor() as cur:
        if label_id is None:
            cur.execute(
                "DELETE FROM label_rules WHERE target_type = ? AND target = ?",
                (target_type, target),
            )
        else:
            cur.execute(
                "INSERT INTO label_rules (label_id, target_type, target) VALUES (?, ?, ?) "
                "ON CONFLICT(target_type, target) DO UPDATE SET label_id = excluded.label_id",
                (label_id, target_type, target),
            )


def summary_by_label(start_ts: float, end_ts: float, include_idle: bool = False):
    """Hours per label. Resolution order for each span: domain rule, then app rule.
    Spans without a matching rule land in the 'Unlabeled' bucket (id=null)."""
    idle_clause = "" if include_idle else "AND e.idle = 0 "
    q = (
        "SELECT l.id, l.name, l.color, "
        "       SUM(MIN(e.end_ts, :end) - MAX(e.start_ts, :start)) AS total "
        "FROM events e "
        "LEFT JOIN label_rules ld ON ld.target_type='domain' AND ld.target = e.domain "
        "LEFT JOIN label_rules la ON la.target_type='app'    AND la.target = e.app "
        "LEFT JOIN labels      l  ON l.id = COALESCE(ld.label_id, la.label_id) "
        "WHERE e.start_ts < :end AND e.end_ts > :start "
        + idle_clause
        + "GROUP BY l.id, l.name, l.color "
        "ORDER BY total DESC"
    )
    with cursor() as cur:
        cur.execute(q, {"start": start_ts, "end": end_ts})
        out = []
        for r in cur.fetchall():
            out.append({
                "label_id": r[0],
                "name": r[1] or "Unlabeled",
                "color": r[2] or "#6b7280",
                "seconds": r[3] or 0.0,
            })
        return out


def totals(start_ts: float, end_ts: float):
    q = (
        f"SELECT SUM({_CLIPPED}), "
        f"       SUM(CASE WHEN idle=1 THEN {_CLIPPED} ELSE 0 END) "
        f"FROM events WHERE start_ts < :end AND end_ts > :start"
    )
    with cursor() as cur:
        cur.execute(q, {"start": start_ts, "end": end_ts})
        row = cur.fetchone()
        total = row[0] or 0.0
        idle = row[1] or 0.0
        return {"active_seconds": total - idle, "idle_seconds": idle, "total_seconds": total}
