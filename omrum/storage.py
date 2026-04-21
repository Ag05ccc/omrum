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

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
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
# Lightweight in-memory cache for the settings table. Tracker polls it every
# few seconds; reading from a dict is cheaper (and doesn't need a DB lock)
# than running SELECT on every tick.
_settings: dict[str, str] = {}


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
    # Prime the settings cache.
    _settings.clear()
    for k, v in _conn.execute("SELECT key, value FROM settings").fetchall():
        _settings[k] = v


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
    `app`, `seconds`, `when_ts`, and optionally `title`, `domain`, `label`.

    Label rules:
    - An event may carry a per-event `label` (label name). A rule is created
      for that event's target (domain if set, else app).
    - `apply_label_name` is a fallback: it's applied to every target that the
      per-event labels didn't cover. Use it alone for single-label imports
      (Clockify); leave it blank for imports that have per-row productivity
      (DeskTime).

    Returns {inserted, labeled_targets}.
    """
    if not events:
        return {"inserted": 0, "labeled_targets": 0}

    # Resolve (or create) every label name we'll need, before opening the
    # write cursor — avoids re-entering the storage lock.
    needed: set[str] = set()
    if apply_label_name:
        needed.add(apply_label_name)
    for ev in events:
        nm = (ev.get("label") or "").strip()
        if nm:
            needed.add(nm)

    label_ids: dict[str, int] = {}
    if needed:
        with cursor() as cur:
            for nm in needed:
                row = cur.execute("SELECT id FROM labels WHERE name = ?", (nm,)).fetchone()
                if row:
                    label_ids[nm] = int(row[0])
                else:
                    cur.execute("INSERT INTO labels (name, color) VALUES (?, ?)",
                                (nm, "#4ade80"))
                    label_ids[nm] = int(cur.lastrowid)

    fallback_id = label_ids.get(apply_label_name) if apply_label_name else None

    inserted = 0
    # (target_type, target) -> label_id, from per-event labels (last writer wins)
    per_target: dict[tuple[str, str], int] = {}
    all_apps: set[str] = set()
    all_domains: set[str] = set()

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
            all_apps.add(app)
            if domain:
                all_domains.add(domain)

            ev_label = (ev.get("label") or "").strip()
            if ev_label and ev_label in label_ids:
                lid = label_ids[ev_label]
                # Per-event label applies to the most-specific target we have.
                if domain:
                    per_target[("domain", domain)] = lid
                else:
                    per_target[("app", app)] = lid

        labeled = 0
        # First: per-event labels (specific).
        for (tt, target), lid in per_target.items():
            cur.execute(
                "INSERT INTO label_rules (label_id, target_type, target) VALUES (?, ?, ?) "
                "ON CONFLICT(target_type, target) DO UPDATE SET label_id = excluded.label_id",
                (lid, tt, target),
            )
            labeled += 1
        # Then: fallback label fills in anything per-event didn't cover.
        if fallback_id is not None:
            for a in all_apps:
                if ("app", a) in per_target:
                    continue
                cur.execute(
                    "INSERT INTO label_rules (label_id, target_type, target) VALUES (?, 'app', ?) "
                    "ON CONFLICT(target_type, target) DO UPDATE SET label_id = excluded.label_id",
                    (fallback_id, a),
                )
                labeled += 1
            for d in all_domains:
                if ("domain", d) in per_target:
                    continue
                cur.execute(
                    "INSERT INTO label_rules (label_id, target_type, target) VALUES (?, 'domain', ?) "
                    "ON CONFLICT(target_type, target) DO UPDATE SET label_id = excluded.label_id",
                    (fallback_id, d),
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
        f"SELECT app, SUM({_CLIPPED}) AS total, MAX(MIN(end_ts, :end)) AS last_seen, "
        f"       MIN(MAX(start_ts, :start)) AS first_seen "
        f"FROM events {_overlap_filter(include_idle)}"
        f"GROUP BY app ORDER BY total DESC LIMIT :limit"
    )
    with cursor() as cur:
        cur.execute(q, {"start": start_ts, "end": end_ts, "limit": limit})
        return [{"app": r[0], "seconds": r[1] or 0.0,
                 "last_seen": r[2], "first_seen": r[3]} for r in cur.fetchall()]


def summary_by_domain(start_ts: float, end_ts: float, include_idle: bool = False, limit: int = 200):
    q = (
        f"SELECT domain, SUM({_CLIPPED}) AS total, MAX(MIN(end_ts, :end)) AS last_seen, "
        f"       MIN(MAX(start_ts, :start)) AS first_seen "
        f"FROM events {_overlap_filter(include_idle)}"
        f"AND domain IS NOT NULL AND domain != '' "
        f"GROUP BY domain ORDER BY total DESC LIMIT :limit"
    )
    with cursor() as cur:
        cur.execute(q, {"start": start_ts, "end": end_ts, "limit": limit})
        return [{"domain": r[0], "seconds": r[1] or 0.0,
                 "last_seen": r[2], "first_seen": r[3]} for r in cur.fetchall()]


def summary_activity(start_ts: float, end_ts: float, include_idle: bool = False,
                     limit: int = 200, titles_per_row: int = 5, min_title_seconds: float = 5.0):
    """URL-aware: browser spans bucket by domain, others by app. Replaces the
    old "apps" view where chrome/firefox would swallow all browser time.

    Each row also carries the top `titles_per_row` window titles (by time)
    so the UI can surface "what pages / windows were these?" on hover —
    particularly useful for the bare `chrome` row where no URL was captured.
    """
    q = (
        "SELECT "
        "  CASE WHEN domain IS NOT NULL AND domain != '' THEN domain ELSE app END AS label, "
        "  CASE WHEN domain IS NOT NULL AND domain != '' THEN 'web' ELSE 'app' END AS kind, "
        f" SUM({_CLIPPED}) AS total, MAX(MIN(end_ts, :end)) AS last_seen, "
        f" MIN(MAX(start_ts, :start)) AS first_seen "
        f"FROM events {_overlap_filter(include_idle)}"
        "GROUP BY label, kind ORDER BY total DESC LIMIT :limit"
    )
    # Fetch per-(label, kind, title) totals so we can attach top titles to
    # each row in Python. One extra query over the same events is cheaper
    # than correlating a subquery for each row.
    q_titles = (
        "SELECT "
        "  CASE WHEN domain IS NOT NULL AND domain != '' THEN domain ELSE app END AS label, "
        "  CASE WHEN domain IS NOT NULL AND domain != '' THEN 'web' ELSE 'app' END AS kind, "
        "  title, "
        f" SUM({_CLIPPED}) AS total "
        f"FROM events {_overlap_filter(include_idle)}"
        "AND title IS NOT NULL AND title != '' "
        "GROUP BY label, kind, title "
        "HAVING total >= :min_sec "
        "ORDER BY label, kind, total DESC"
    )
    with cursor() as cur:
        cur.execute(q, {"start": start_ts, "end": end_ts, "limit": limit})
        rows = [{"label": r[0], "kind": r[1], "seconds": r[2] or 0.0,
                 "last_seen": r[3], "first_seen": r[4], "top_titles": []}
                for r in cur.fetchall()]
        index = {(r["label"], r["kind"]): r for r in rows}
        cur.execute(q_titles, {"start": start_ts, "end": end_ts,
                               "min_sec": min_title_seconds})
        for label, kind, title, total in cur.fetchall():
            row = index.get((label, kind))
            if row is None:
                continue
            if len(row["top_titles"]) >= titles_per_row:
                continue
            row["top_titles"].append({"title": title, "seconds": total or 0.0})
        return rows


# Map "well-known" label names to productivity categories for the timeline view.
# Everything else with a rule → neutral; no rule → unlabeled; idle → idle.
_PRODUCTIVE_NAMES = frozenset({"verimli", "productive"})
_UNPRODUCTIVE_NAMES = frozenset({"verimsiz", "unproductive"})


def summary_timeline(start_ts: float, end_ts: float, bucket_s: float):
    """Bucket every event into fixed-size time slots, classifying each second
    as productive / unproductive / neutral / unlabeled / idle. Used by the
    dashboard's productivity bar. Returns a list of buckets:
      [{t, productive, unproductive, neutral, unlabeled, idle}, ...]
    """
    if bucket_s <= 0 or end_ts <= start_ts:
        return []

    n = int((end_ts - start_ts) // bucket_s) + 1
    buckets = []
    for i in range(n):
        t = start_ts + i * bucket_s
        if t >= end_ts:
            break
        buckets.append({
            "t": t, "productive": 0.0, "unproductive": 0.0,
            "neutral": 0.0, "unlabeled": 0.0, "idle": 0.0,
        })
    # Parallel per-bucket breakdown: {(label, kind, cat) -> seconds}.
    items_per_bucket: list[dict] = [{} for _ in buckets]

    with cursor() as cur:
        cur.execute("SELECT id, name FROM labels")
        label_name = {int(r[0]): (r[1] or "").strip().lower() for r in cur.fetchall()}
        rules = {}
        cur.execute("SELECT target_type, target, label_id FROM label_rules")
        for tt, t, lid in cur.fetchall():
            rules[(tt, t)] = int(lid)

        cur.execute(
            "SELECT start_ts, end_ts, app, domain, idle FROM events "
            "WHERE start_ts < :end AND end_ts > :start",
            {"start": start_ts, "end": end_ts},
        )
        for s, e, app, domain, is_idle in cur.fetchall():
            s = max(float(s), start_ts)
            e = min(float(e), end_ts)
            if e <= s:
                continue
            if is_idle:
                cat = "idle"
            else:
                lid = rules.get(("domain", domain)) if domain else None
                if lid is None:
                    lid = rules.get(("app", app))
                if lid is None:
                    cat = "unlabeled"
                else:
                    nm = label_name.get(lid, "")
                    if nm in _PRODUCTIVE_NAMES:
                        cat = "productive"
                    elif nm in _UNPRODUCTIVE_NAMES:
                        cat = "unproductive"
                    else:
                        cat = "neutral"

            if is_idle:
                item_key = None
            elif domain:
                item_key = (domain, "web", cat)
            else:
                item_key = ((app or "(unknown)"), "app", cat)

            bi = int((s - start_ts) // bucket_s)
            while s < e and 0 <= bi < len(buckets):
                bend = start_ts + (bi + 1) * bucket_s
                step = min(e, bend) - s
                if step > 0:
                    buckets[bi][cat] += step
                    if item_key is not None:
                        items_per_bucket[bi][item_key] = (
                            items_per_bucket[bi].get(item_key, 0.0) + step
                        )
                s = bend
                bi += 1

    # Finalize: top 3 apps/urls per bucket so tooltips can show them.
    for i, items in enumerate(items_per_bucket):
        if not items:
            buckets[i]["top_items"] = []
            continue
        ranked = sorted(items.items(), key=lambda kv: -kv[1])[:3]
        buckets[i]["top_items"] = [
            {"label": k[0], "kind": k[1], "cat": k[2], "seconds": v}
            for k, v in ranked
        ]

    return buckets


# ---------- settings ----------

def get_setting(key: str, default: Optional[str] = None) -> Optional[str]:
    return _settings.get(key, default)


def set_setting(key: str, value) -> None:
    sval = str(value)
    _settings[key] = sval
    with cursor() as cur:
        cur.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, sval),
        )


def get_setting_float(key: str, default: float) -> float:
    v = _settings.get(key)
    if v is None:
        return default
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


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
