# Omrum

**Local-first desktop time tracker for Linux / X11.** Measures how many hours you spend in every app and on every website, labels them (productive / neutral / unproductive, in any language you like), and shows daily / weekly / monthly / yearly / custom-range reports. Everything stays on your machine — no cloud, no accounts, no telemetry.

Inspired by DeskTime, but without the subscription or the data leaving your computer.

```
┌─────────────────────────────────────────────┐
│  Omrum      [Day][Week][Month][Year][Range] │
│             + Add time • Import CSV • ↻     │
├─────────────────────────────────────────────┤
│  ‹   Week 16, 2026 (Apr 13–Apr 19)    ›     │
├─────────────────────────────────────────────┤
│  Active  28h 14m     Idle 1h 02m    Total…  │
├─────────────────────────────────────────────┤
│  By category                                │
│    ██████████  verimli    18h 40m           │
│    ████        genel       4h 12m           │
│    ██          verimsiz    2h 20m           │
│  Where time went                            │
│    ███████  web  claude.ai          9h 22m  │
│    █████    app  code               6h 50m  │
│    ████     web  github.com         4h 30m  │
└─────────────────────────────────────────────┘
```

## Features

- **Automatic app tracking** — polls the active X11 window every 2 s, records app + window title, compresses consecutive identical spans.
- **Browser URL tracking** — a companion MV3 extension (Chrome/Firefox) reports the active tab so time is bucketed by domain (`youtube.com`, `claude.ai`), not lumped under `chrome`.
- **Idle detection** — the X11 MIT-SCREEN-SAVER extension watches for input; time past your idle threshold (default 2 min) is tagged separately so it doesn't inflate totals.
- **Labels / categories** — tag apps and domains as `verimli` / `genel` / `verimsiz` (or your own), see hours per label. Domain rules override app rules (so `youtube.com = verimsiz` beats `chrome = verimli`).
- **Period reports** — Day / Week / Month / Year tabs with prev/next navigation, plus a **custom date range** with "Last 7/30/90/365 days" presets.
- **Manual entries** — add time you tracked elsewhere, delete mistaken or irrelevant time.
- **Clockify CSV import** — drop in a Clockify Summary export and it's applied retroactively with an optional label.
- **System tray icon** — click to open the dashboard, menu entries for Restart / Quit.
- **Autostart on login** — one command and Omrum starts with your session.
- **Single SQLite file** — your data is `~/.local/share/omrum/omrum.db`, easy to back up or query directly.

## Requirements

- Linux with **X11** session (`echo $XDG_SESSION_TYPE` must print `x11`). Wayland is on the roadmap, not yet implemented.
- **Python ≥ 3.10**.
- System packages for the tray icon: on Ubuntu/Debian these are usually already present —
  ```bash
  sudo apt install python3-gi gir1.2-appindicator3-0.1 gnome-shell-extension-appindicator
  ```
  On GNOME, make sure the **AppIndicator** extension is enabled (`gnome-extensions enable ubuntu-appindicators@ubuntu.com`), otherwise the tray icon will not render.
- A Chromium-based browser or Firefox for URL tracking (optional).

## Install

```bash
git clone https://github.com/<you>/omrum.git
cd omrum
python3 -m venv --system-site-packages .venv        # --system-site-packages so PyGObject is visible
source .venv/bin/activate
pip install -e .
```

`--system-site-packages` is the one nuance: the tray uses PyGObject/AppIndicator3 which Ubuntu ships via apt, not pip. A regular venv can't see them.

## Run

```bash
omrum                 # foreground, with tray + HTTP server + tracker
omrum --verbose       # verbose logs to stderr
omrum --no-tray       # headless (useful for a systemd service)
omrum --no-tracker    # dashboard only, good for viewing historical data
```

Open <http://127.0.0.1:7942/> in your browser (or click the tray icon).

### Autostart at login

```bash
omrum install     # creates ~/.config/autostart/omrum.desktop, an app-menu entry, and a 256×256 icon
omrum uninstall   # removes them
```

After `omrum install`, Omrum starts automatically on next login and sits in the tray.

## Install the browser extension

Without this, browser time stays lumped under `chrome` / `firefox` — you won't see per-domain breakdowns.

### Chrome / Chromium / Brave / Edge

1. Visit `chrome://extensions`.
2. Toggle **Developer mode** (top right).
3. Click **Load unpacked** → select the `extension/` directory.

### Firefox (temporary install)

1. Visit `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** → select `extension/manifest.json`.

The extension POSTs the active tab URL to `http://127.0.0.1:7942/api/browser` on every tab/focus change plus a 15-second heartbeat. If the daemon isn't running the posts silently fail.

## Using the dashboard

### Periods

Click the tabs — **Day / Week / Month / Year / Range**. Use `‹` / `›` to move one period earlier/later, **Today** to jump back to now. In **Range** mode, a From / To date picker appears below the tabs with quick "Last 7 / 30 / 90 / 365 days" chips.

### Labels

Three labels are seeded by default: `verimli` (productive, green), `genel` (neutral, gray), `verimsiz` (unproductive, red) — Turkish, because that's what the author uses. Rename them, change colors, or add new ones in **Manage labels** (header button).

To assign a label: click any bar in the **Where time went** / **By application** / **By website** lists and pick a label. All time for that app (or domain) rolls into that label's bucket in **By category**.

### Adding / deleting time

- **+ Add time** (header) — enter an app name and/or website, a duration in hours and minutes, and when it "ends". Useful for logging work you did offline or on another device.
- **⋯** on each bar — deletes time for that app or domain, either just within the current period or across all history. Confirmations required.

### Importing Clockify exports

Go to Clockify → **Reports → Summary**, group by Project + Description, export CSV.

In Omrum click **Import CSV**:

1. Pick the file — the anchor date auto-fills from the filename (`..._MM_DD_YYYY-MM_DD_YYYY.csv`).
2. Optional: enter a label (e.g. `verimli`) to tag every imported row.
3. Preview shows total hours + top projects.
4. **Import** — events are stacked sequentially ending at your anchor; imported apps are auto-labeled.

Spans don't overlap, so summing works correctly. Re-importing the same file creates duplicates (no dedup).

### Restart daemon

**↻ Restart** in the header (or the tray **Restart daemon** entry) `os.execv`'s a fresh process with the same flags. Current spans are flushed to disk first; the browser auto-reloads once the new daemon answers health checks.

## Data model

A single SQLite file. One `events` table, one `labels` table, one `label_rules` table.

```sql
CREATE TABLE events (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    start_ts  REAL    NOT NULL,   -- unix epoch seconds
    end_ts    REAL    NOT NULL,
    duration  REAL    NOT NULL,
    app       TEXT    NOT NULL,   -- process name, e.g. 'firefox', 'code'
    title     TEXT,                -- window title
    url       TEXT,                -- only set when app is a known browser
    domain    TEXT,                -- hostname from url
    idle      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE labels (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    name  TEXT NOT NULL UNIQUE,
    color TEXT NOT NULL DEFAULT '#888'
);

CREATE TABLE label_rules (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    label_id    INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
    target_type TEXT    NOT NULL CHECK(target_type IN ('app','domain')),
    target      TEXT    NOT NULL,
    UNIQUE(target_type, target)
);
```

Query it directly if you want:

```bash
sqlite3 ~/.local/share/omrum/omrum.db \
  "SELECT app, printf('%.1fh', SUM(duration)/3600.0) FROM events
   WHERE idle=0 AND start_ts > strftime('%s','now','-7 days')
   GROUP BY app ORDER BY 2 DESC;"
```

## Configuration

Environment variables:

| Variable       | Default                      | Meaning                      |
| -------------- | ---------------------------- | ---------------------------- |
| `OMRUM_DATA`   | `~/.local/share/omrum`       | Database directory.          |
| `OMRUM_HOST`   | `127.0.0.1`                  | HTTP bind address.           |
| `OMRUM_PORT`   | `7942`                       | HTTP port.                   |
| `OMRUM_POLL`   | `2.0`                        | Polling interval in seconds. |
| `OMRUM_IDLE`   | `120`                        | Idle threshold in seconds.   |

## HTTP API

The dashboard talks to these endpoints; they're also scriptable.

| Method | Path                           | Purpose                                   |
| ------ | ------------------------------ | ----------------------------------------- |
| GET    | `/api/health`                  | Liveness probe.                           |
| GET    | `/api/summary`                 | Period totals + activity + labels.        |
| POST   | `/api/browser`                 | Browser extension reports the active URL. |
| GET    | `/api/labels`                  | List labels + rules.                      |
| POST   | `/api/labels`                  | Create a label.                           |
| PATCH  | `/api/labels/:id`              | Rename or recolor.                        |
| DELETE | `/api/labels/:id`              | Delete a label (rules cascade).           |
| POST   | `/api/assign`                  | Tag an app/domain with a label.           |
| POST   | `/api/manual`                  | Insert a manual time span.                |
| POST   | `/api/import`                  | Batch-insert (used by Clockify importer). |
| DELETE | `/api/events`                  | Delete events for an app/domain.          |
| POST   | `/api/restart`                 | Re-exec the daemon (preserves data).      |

`/api/summary` accepts `period=day|week|month|year|range` plus either `anchor=YYYY-MM-DD` or, for range, `start=YYYY-MM-DD&end=YYYY-MM-DD`. Response includes `window` (prev/next anchors for navigation), `totals`, `activity`, `apps`, `domains`, `by_label`.

## Project layout

```
omrum/
  __main__.py        # CLI: run, install, uninstall
  config.py          # paths, ports, intervals, browser list
  storage.py         # SQLite schema + aggregation + CRUD
  periods.py         # day/week/month/year/range windowing
  window_x11.py      # active-window probe (python-xlib)
  idle.py            # idle probe (MIT-SCREEN-SAVER)
  browser_state.py   # in-memory "current tab URL" with TTL
  tracker.py         # polling loop that writes events
  server.py          # http.server-based HTTP API + dashboard
  tray.py            # pystray tray icon (uses PyGObject/AppIndicator3)
  install.py         # autostart + app-launcher + icon
  web/               # static HTML/CSS/JS for the dashboard
extension/
  manifest.json      # MV3 manifest (Chrome + Firefox)
  background.js      # service worker reporting the active tab
```

## Development

```bash
# Run with live logging, no autostart
python -m omrum -v

# Run against an isolated data dir (leaves your real DB alone)
OMRUM_DATA=/tmp/omrum-dev python -m omrum -v

# Peek at the DB
sqlite3 ~/.local/share/omrum/omrum.db .schema
```

## Roadmap

- Wayland support (GNOME Shell extension or Mutter D-Bus).
- Pause/resume from the tray menu.
- CSV / JSON export.
- Timeline (Gantt-style day strip) + per-hour heatmap.
- De-duplicating re-imports.
- Per-app icons in the dashboard.

## Contributing

Bug reports and PRs welcome. The stack is deliberately tiny — stdlib `http.server`, raw SQL, vanilla JS — so it stays easy to fork and tweak for your own workflow.

## License

[MIT](LICENSE).
