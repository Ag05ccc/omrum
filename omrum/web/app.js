const fmt = (sec) => {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
};

const escapeHtml = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const state = {
  period: "day",
  anchor: null,
  range: { start: null, end: null }, // YYYY-MM-DD, inclusive
  labels: [],
  window: { start: 0, end: 0, label: "" },
  pickerTarget: null,
  rowTarget: null,
};

const dayStr = (d) => {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
};

function parseRangeAnchor(s) {
  const [a, b] = String(s || "").split("..");
  return (a && b) ? { start: a, end: b } : null;
}

async function api(method, path, body) {
  const opts = { method, headers: { "Content-Type": "application/json" } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(path, opts);
  return r.json();
}

function labelChip(label) {
  if (!label) return "";
  return `<span class="chip-label" style="background:${label.color}">${escapeHtml(label.name)}</span>`;
}

function fmtHm(ts) {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function whenLabel(it) {
  // Show the active time range on the day view; elide on longer windows.
  if (state.period !== "day") return "";
  const a = fmtHm(it.first_seen), b = fmtHm(it.last_seen);
  if (!a && !b) return "";
  if (a === b || !a) return b;
  if (!b) return a;
  return `${a}–${b}`;
}

function renderBars(el, items, nameKey, kindKey, clickable) {
  el.innerHTML = "";
  if (!items.length) {
    el.innerHTML = '<li class="nonclick" style="color:var(--muted)">No data yet.</li>';
    return;
  }
  const max = items[0].seconds || 1;
  for (const it of items) {
    const pct = Math.max(2, (it.seconds / max) * 100);
    const kind = kindKey ? it[kindKey] : "";
    const li = document.createElement("li");
    if (kind) li.classList.add(kind);
    if (!clickable) li.classList.add("nonclick");
    const name = it[nameKey] || "(unknown)";
    const kindChip = kind ? `<span class="kind">${kind}</span>` : "";
    const label = it.assigned || null;
    const more = clickable ? `<button class="more" title="Actions">⋯</button>` : "";
    const when = whenLabel(it);
    const whenSpan = when ? `<span class="when" title="First – last activity in this period">${when}</span>` : "";
    li.innerHTML = `
      <div class="row">
        ${kindChip}
        <span class="name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
        ${labelChip(label)}
        ${whenSpan}
        <span class="time">${fmt(it.seconds)}</span>
        ${more}
      </div>
      <div class="track"><div class="fill" style="width:${pct}%"></div></div>`;
    if (clickable) {
      const tt = kind === "web" ? "domain" : kind === "app" ? "app" : (nameKey === "domain" ? "domain" : "app");
      li.addEventListener("click", (e) => {
        if (e.target.closest(".more")) return;
        openPicker(e.currentTarget, tt, name, label ? label.id : null);
      });
      li.querySelector(".more").addEventListener("click", (e) => {
        e.stopPropagation();
        openRowMenu(e.currentTarget, tt, name);
      });
    }
    el.appendChild(li);
  }
}

// Classify an activity item for the "Where time went" grouped view.
// Known productive/unproductive label names win; anything else with a rule
// → neutral; no rule → unlabeled.
const PRODUCTIVE_LABELS = new Set(["verimli", "productive"]);
const UNPRODUCTIVE_LABELS = new Set(["verimsiz", "unproductive"]);

function categoryOf(item) {
  if (!item.assigned) return "unlabeled";
  const nm = (item.assigned.name || "").toLowerCase();
  if (PRODUCTIVE_LABELS.has(nm)) return "productive";
  if (UNPRODUCTIVE_LABELS.has(nm)) return "unproductive";
  return "neutral";
}

const GROUP_META = [
  { cat: "productive",   title: "Productive apps" },
  { cat: "unproductive", title: "Unproductive apps" },
  { cat: "neutral",      title: "Neutral apps" },
  { cat: "unlabeled",    title: "Unlabeled" },
];

function renderGrouped(items) {
  const el = document.getElementById("grouped");
  el.innerHTML = "";
  const minSec = (parseFloat(document.getElementById("min-dur").value) || 0) * 60;
  const filtered = items.filter((it) => (it.seconds || 0) >= minSec);
  if (!filtered.length) {
    el.innerHTML = `<div class="group-empty">No activity over ${minSec/60}m. Lower the filter to see more.</div>`;
    return;
  }
  const buckets = { productive: [], unproductive: [], neutral: [], unlabeled: [] };
  for (const it of filtered) buckets[categoryOf(it)].push(it);

  for (const { cat, title } of GROUP_META) {
    const rows = buckets[cat];
    if (!rows.length) continue;
    rows.sort((a, b) => (b.seconds || 0) - (a.seconds || 0));
    const total = rows.reduce((s, x) => s + (x.seconds || 0), 0);

    const group = document.createElement("div");
    group.className = "group";
    const head = document.createElement("div");
    head.className = `group-head ${cat}`;
    head.innerHTML = `<span>${title} · ${fmt(total)}</span><span class="count">${rows.length}</span>`;
    group.appendChild(head);

    const grid = document.createElement("div");
    grid.className = "group-grid";
    for (const it of rows) {
      const div = document.createElement("div");
      div.className = "item";
      const tt = it.kind === "web" ? "domain" : "app";
      const when = whenLabel(it);
      const whenSpan = when ? `<span class="when">${when}</span>` : "";
      div.innerHTML = `
        <span class="dot ${it.kind}"></span>
        <span class="item-name" title="${escapeHtml(it.label)}">${escapeHtml(it.label)}</span>
        ${whenSpan}
        <span class="item-time">${fmt(it.seconds)}</span>
        <button class="more" title="Actions">⋯</button>`;
      div.addEventListener("click", (e) => {
        if (e.target.closest(".more")) return;
        openPicker(e.currentTarget, tt, it.label, it.assigned ? it.assigned.id : null);
      });
      div.querySelector(".more").addEventListener("click", (e) => {
        e.stopPropagation();
        openRowMenu(e.currentTarget, tt, it.label);
      });
      grid.appendChild(div);
    }
    group.appendChild(grid);
    el.appendChild(group);
  }
}

function renderTimeline(timeline) {
  const el = document.getElementById("timeline");
  const axisEl = document.getElementById("timeline-axis");
  const hintEl = document.getElementById("timeline-hint");
  el.innerHTML = "";
  axisEl.innerHTML = "";
  if (!timeline || !timeline.buckets || !timeline.buckets.length) {
    el.innerHTML = '<div style="color:var(--muted); padding: 30px; text-align:center; flex:1;">No data yet.</div>';
    return;
  }
  const bucketS = timeline.bucket_s;
  const isHourly = bucketS <= 3600;
  const isMultiHour = bucketS > 3600 && bucketS < 86400;
  const isDaily = bucketS >= 86400;
  hintEl.textContent = isHourly
    ? "Each column is one hour of the day. Hover for details."
    : isMultiHour
      ? `Each column is ${Math.round(bucketS / 3600)} hours. Hover for details.`
      : "Each column is one day. Hover for details.";

  // Scale height to the bucket's capacity (bucketS) so partial hours show partial bars.
  for (const b of timeline.buckets) {
    const total = b.productive + b.unproductive + b.neutral + b.unlabeled + b.idle;
    const fill = Math.min(1, total / bucketS);
    const fillPct = fill * 100;
    const col = document.createElement("div");
    col.className = "bucket";
    const seg = (cls, sec) => {
      if (sec <= 0) return "";
      const pct = (sec / Math.max(total, 1)) * fillPct;
      return `<div class="seg ${cls}" style="height:${pct}%"></div>`;
    };
    // Order bottom-up (column-reverse flex): productive at base, then neutral/unlabeled, idle, unproductive on top.
    const body =
      seg("productive",   b.productive) +
      seg("neutral",      b.neutral) +
      seg("unlabeled",    b.unlabeled) +
      seg("unproductive", b.unproductive) +
      seg("idle",         b.idle);
    const when = new Date(b.t * 1000);
    const pad = (n) => String(n).padStart(2, "0");
    const tipHead = isDaily
      ? when.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })
      : isMultiHour
        ? `${pad(when.getHours())}:00 – ${pad((when.getHours() + Math.round(bucketS / 3600)) % 24)}:00`
        : `${pad(when.getHours())}:00 – ${pad((when.getHours() + 1) % 24)}:00`;
    const tipLine = (label, sec) => sec > 0 ? `\n${label}: ${fmt(sec)}` : "";
    const tipText =
      tipHead +
      tipLine("Productive",   b.productive) +
      tipLine("Unproductive", b.unproductive) +
      tipLine("Neutral",      b.neutral) +
      tipLine("Unlabeled",    b.unlabeled) +
      tipLine("Idle",         b.idle);
    col.innerHTML = body + `<div class="tip">${escapeHtml(tipText).replace(/\n/g, "<br>")}</div>`;
    el.appendChild(col);
  }

  // Axis: show ~6-8 evenly-spaced ticks.
  const n = timeline.buckets.length;
  const target = Math.min(8, n);
  const step = Math.max(1, Math.round(n / target));
  for (let i = 0; i < n; i++) {
    const span = document.createElement("span");
    if (i % step === 0 || i === n - 1) {
      const when = new Date(timeline.buckets[i].t * 1000);
      const pad = (nn) => String(nn).padStart(2, "0");
      span.textContent = isDaily
        ? when.toLocaleDateString(undefined, { month: "numeric", day: "numeric" })
        : `${pad(when.getHours())}`;
    }
    axisEl.appendChild(span);
  }
}

function renderLabelBars(el, items) {
  el.innerHTML = "";
  if (!items.length) {
    el.innerHTML = '<li class="nonclick" style="color:var(--muted)">No data yet.</li>';
    return;
  }
  const max = items[0].seconds || 1;
  for (const it of items) {
    const pct = Math.max(2, (it.seconds / max) * 100);
    const li = document.createElement("li");
    li.classList.add("nonclick");
    const color = it.color || "#6b7280";
    li.innerHTML = `
      <div class="row">
        <span class="chip-label" style="background:${color}">${escapeHtml(it.name)}</span>
        <span class="name"></span>
        <span class="time">${fmt(it.seconds)}</span>
      </div>
      <div class="track"><div class="fill" style="width:${pct}%; background:${color}"></div></div>`;
    el.appendChild(li);
  }
}

// ---------- label picker ----------
const picker = document.getElementById("picker");
const pickerList = document.getElementById("picker-list");

function openPicker(anchorEl, target_type, target, currentLabelId) {
  closeAllPopovers();
  state.pickerTarget = { target_type, target, currentLabelId };
  pickerList.innerHTML = "";
  for (const lb of state.labels) {
    const li = document.createElement("li");
    if (lb.id === currentLabelId) li.classList.add("current");
    li.innerHTML = `<span class="dot" style="background:${lb.color}"></span><span>${escapeHtml(lb.name)}</span>`;
    li.addEventListener("click", () => assign(lb.id));
    pickerList.appendChild(li);
  }
  positionPopover(picker, anchorEl);
  picker.classList.remove("hidden");
}

function closePicker() {
  picker.classList.add("hidden");
  state.pickerTarget = null;
}

async function assign(label_id) {
  if (!state.pickerTarget) return;
  const { target_type, target } = state.pickerTarget;
  await api("POST", "/api/assign", { target_type, target, label_id });
  closePicker();
  load();
}

document.getElementById("picker-clear").addEventListener("click", () => assign(null));

// ---------- row action menu (delete) ----------
const rowmenu = document.getElementById("rowmenu");
const rowmenuTarget = document.getElementById("rowmenu-target");

function openRowMenu(anchorEl, target_type, target) {
  closeAllPopovers();
  state.rowTarget = { target_type, target };
  rowmenuTarget.textContent = `${target_type}: ${target}`;
  positionPopover(rowmenu, anchorEl);
  rowmenu.classList.remove("hidden");
}

function closeRowMenu() {
  rowmenu.classList.add("hidden");
  state.rowTarget = null;
}

async function deleteRow(scoped) {
  if (!state.rowTarget) return;
  const { target_type, target } = state.rowTarget;
  const label = state.window.label || "this period";
  const msg = scoped
    ? `Delete all time for "${target}" in ${label}?`
    : `Delete ALL time for "${target}" across ALL history? This cannot be undone.`;
  if (!confirm(msg)) return;
  const body = { [target_type === "app" ? "app" : "domain"]: target };
  if (scoped) {
    body.start_ts = state.window.start;
    body.end_ts = state.window.end;
  }
  const r = await api("DELETE", "/api/events", body);
  closeRowMenu();
  load();
}

document.getElementById("rowmenu-del-period").addEventListener("click", () => deleteRow(true));
document.getElementById("rowmenu-del-all").addEventListener("click", () => deleteRow(false));

// ---------- shared popover helpers ----------
function positionPopover(el, anchorEl) {
  const rect = anchorEl.getBoundingClientRect();
  el.style.top = `${window.scrollY + rect.bottom + 4}px`;
  el.style.left = `${Math.min(window.innerWidth - 220, rect.left)}px`;
}
function closeAllPopovers() {
  closePicker();
  closeRowMenu();
}
document.addEventListener("click", (e) => {
  const inPicker = picker.contains(e.target);
  const inRowmenu = rowmenu.contains(e.target);
  const onBar = e.target.closest(".bars li");
  if (!inPicker && !inRowmenu && !onBar) closeAllPopovers();
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeAllPopovers(); });

// ---------- labels modal ----------
const modal = document.getElementById("modal");
const labelList = document.getElementById("label-list");

function renderLabelList() {
  labelList.innerHTML = "";
  for (const lb of state.labels) {
    const li = document.createElement("li");
    li.innerHTML = `
      <span class="swatch" style="background:${lb.color}"></span>
      <input type="text" value="${escapeHtml(lb.name)}" data-id="${lb.id}" />
      <input type="color" value="${lb.color}" data-id="${lb.id}" />
      <button title="Delete" data-id="${lb.id}">🗑</button>
    `;
    const [nameInput, colorInput, delBtn] = li.querySelectorAll("input[type=text], input[type=color], button");
    const commit = async () => {
      await api("PATCH", `/api/labels/${lb.id}`, { name: nameInput.value.trim(), color: colorInput.value });
      await refreshLabels(); load();
    };
    nameInput.addEventListener("blur", commit);
    nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") e.currentTarget.blur(); });
    colorInput.addEventListener("change", commit);
    delBtn.addEventListener("click", async () => {
      if (!confirm(`Delete label "${lb.name}"? Its rules will be removed.`)) return;
      await api("DELETE", `/api/labels/${lb.id}`);
      await refreshLabels(); load();
    });
    labelList.appendChild(li);
  }
}

document.getElementById("manage-labels").addEventListener("click", async () => {
  await refreshLabels();
  renderLabelList();
  modal.classList.remove("hidden");
});
document.getElementById("modal-close").addEventListener("click", () => modal.classList.add("hidden"));
modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.add("hidden"); });

document.getElementById("label-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = document.getElementById("new-name").value.trim();
  const color = document.getElementById("new-color").value;
  if (!name) return;
  await api("POST", "/api/labels", { name, color });
  document.getElementById("new-name").value = "";
  await refreshLabels();
  renderLabelList();
  load();
});

async function refreshLabels() {
  const r = await api("GET", "/api/labels");
  state.labels = r.labels || [];
}

// ---------- add time modal ----------
const addModal = document.getElementById("add-modal");
const addApp = document.getElementById("add-app");
const addDomain = document.getElementById("add-domain");
const addHours = document.getElementById("add-hours");
const addMins = document.getElementById("add-mins");
const addWhen = document.getElementById("add-when");

function openAddTime() {
  addApp.value = "";
  addDomain.value = "";
  addHours.value = "0";
  addMins.value = "30";
  // datetime-local wants YYYY-MM-DDTHH:MM local; default = now
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  addWhen.value = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  addModal.classList.remove("hidden");
  addApp.focus();
}

document.getElementById("add-time").addEventListener("click", openAddTime);
document.getElementById("add-close").addEventListener("click", () => addModal.classList.add("hidden"));
document.getElementById("add-cancel").addEventListener("click", () => addModal.classList.add("hidden"));
addModal.addEventListener("click", (e) => { if (e.target === addModal) addModal.classList.add("hidden"); });

document.getElementById("add-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const app = addApp.value.trim();
  const domain = addDomain.value.trim();
  const hours = parseInt(addHours.value || "0", 10);
  const mins = parseInt(addMins.value || "0", 10);
  const seconds = hours * 3600 + mins * 60;
  if (!app && !domain) return alert("App or website required.");
  if (seconds <= 0) return alert("Duration must be > 0.");
  // datetime-local is in local timezone; parsing as Date handles that
  const when = addWhen.value ? new Date(addWhen.value) : new Date();
  const when_ts = (when.getTime() / 1000) - seconds; // span ENDS at that time
  const r = await api("POST", "/api/manual", { app, domain, seconds, when_ts });
  if (r.error) return alert("Error: " + r.error);
  addModal.classList.add("hidden");
  load();
});

// ---------- CSV import ----------
const importModal = document.getElementById("import-modal");
const importFile = document.getElementById("import-file");
const importFilename = document.getElementById("import-filename");
const importAnchor = document.getElementById("import-anchor");
const importLabel = document.getElementById("import-label");
const importPreview = document.getElementById("import-preview");
const importGo = document.getElementById("import-go");
let importParsed = null; // {events: [...], totalSeconds, rowCount}

function parseCsv(text) {
  const rows = [];
  let cell = "", row = [], inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else { inQuotes = false; }
      } else cell += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { row.push(cell); cell = ""; }
      else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
      else if (c === "\r") { /* skip */ }
      else cell += c;
    }
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => c.length));
}

function parseFilenameDateClockify(name) {
  // Clockify naming: ..._MM_DD_YYYY-MM_DD_YYYY.csv — return the END date
  const m = name.match(/(\d{2})_(\d{2})_(\d{4})(?!.*\d)/);
  if (!m) return null;
  const [_, mm, dd, yyyy] = m;
  return `${yyyy}-${mm}-${dd}T23:59`;
}

function hmsToSeconds(s) {
  if (!s) return 0;
  const parts = s.split(":").map(Number);
  if (parts.length === 3 && parts.every(n => !isNaN(n))) return parts[0]*3600 + parts[1]*60 + parts[2];
  if (parts.length === 2 && parts.every(n => !isNaN(n))) return parts[0]*60 + parts[1];
  return 0;
}

function detectFormat(header) {
  const h = header.map(s => s.trim().toLowerCase());
  if (h.includes("date") && h.includes("productivity level") && h.includes("app/url name")) {
    return "desktime";
  }
  if (h.includes("project") && (h.includes("time (decimal)") || h.includes("time (h)"))) {
    return "clockify";
  }
  return null;
}

// DeskTime's "Productivity level" → existing seeded Omrum labels.
const DESKTIME_LABEL = { productive: "verimli", neutral: "genel", unproductive: "verimsiz" };

// DeskTime lists generic browser process rows alongside per-URL rows. Importing
// both would double-count browser time, so we keep the URL-level rows only.
const DESKTIME_SKIP_NAMES = new Set([
  "google chrome", "google-chrome-stable", "msedge", "microsoft edge",
  "firefox", "firefox_firefox", "safari", "unknown app",
]);

function classifyDeskTimeName(name) {
  // Chrome-internal: chrome://newtab, chrome-extension://..., about:blank
  if (/^(chrome:|chrome-extension:|about:)/i.test(name)) return { app: "chrome", domain: null };
  // File paths ("///home/…"): show under a "file" bucket
  if (name.startsWith("///") || name.startsWith("/")) return { app: "file", domain: null };
  // Domain: first path-segment, must be all-lowercase dotted hostname.
  // This correctly excludes "Org.gnome.Nautilus" / "Io.snapcraft.Store".
  const host = name.split(/[\/?#]/)[0];
  if (/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) {
    const normalized = host.startsWith("www.") ? host.slice(4) : host;
    return { app: "chrome", domain: normalized };
  }
  // Match the live tracker, which lowercases every process name — keeps
  // "Code" (DeskTime) and "code" (daemon) in one bucket.
  return { app: name.toLowerCase(), domain: null };
}

function parseClockify(rows) {
  const header = rows[0].map(h => h.trim().toLowerCase());
  const hi = {
    project: header.indexOf("project"),
    description: header.indexOf("description"),
    hms: header.indexOf("time (h)"),
    decimal: header.indexOf("time (decimal)"),
  };
  const events = [];
  let total = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const app = (r[hi.project] || "").trim();
    const title = hi.description >= 0 ? (r[hi.description] || "").trim() : "";
    let sec = 0;
    const d = r[hi.decimal];
    if (d !== undefined && !isNaN(parseFloat(d))) sec = Math.round(parseFloat(d) * 3600);
    else if (hi.hms >= 0) sec = hmsToSeconds((r[hi.hms] || "").trim());
    if (!app || sec <= 0) continue;
    events.push({ app, title, seconds: sec });
    total += sec;
  }
  return { format: "clockify", events, totalSeconds: total, rowCount: events.length, usesRowDates: false };
}

function parseDeskTime(rows) {
  const header = rows[0].map(h => h.trim().toLowerCase());
  const hi = {
    date: header.indexOf("date"),
    name: header.indexOf("app/url name"),
    title: header.indexOf("window title"),
    prod: header.indexOf("productivity level"),
    time: header.indexOf("time"),
  };

  const byDate = new Map();
  const topTargets = {};
  const labelTotals = {};
  let total = 0;
  let skipped = 0;

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    const date = (r[hi.date] || "").trim();
    const name = (r[hi.name] || "").trim();
    const title = hi.title >= 0 ? (r[hi.title] || "").trim() : "";
    const prod = (r[hi.prod] || "").trim().toLowerCase();
    const timeStr = hi.time >= 0 ? (r[hi.time] || "").trim() : "";
    if (!date || !name || !timeStr) continue;
    const sec = hmsToSeconds(timeStr);
    if (sec <= 0) continue;
    if (DESKTIME_SKIP_NAMES.has(name.toLowerCase())) { skipped++; continue; }

    const { app, domain } = classifyDeskTimeName(name);
    const label = DESKTIME_LABEL[prod] || null;

    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push({ app, domain, title: title || null, seconds: sec, label });

    total += sec;
    const key = domain || app;
    topTargets[key] = (topTargets[key] || 0) + sec;
    if (label) labelTotals[label] = (labelTotals[label] || 0) + sec;
  }

  // Stack events per-day: each day's events run sequentially from 00:00 onward,
  // so they don't overlap and show up on the correct calendar day.
  const events = [];
  for (const [date, dayEvents] of byDate) {
    const dayStart = new Date(date + "T00:00:00").getTime() / 1000;
    let cursorTs = dayStart;
    for (const ev of dayEvents) {
      cursorTs += ev.seconds;
      events.push({
        app: ev.app, domain: ev.domain, title: ev.title,
        seconds: ev.seconds, when_ts: cursorTs, label: ev.label,
      });
    }
  }

  const dates = Array.from(byDate.keys()).sort();
  const dateRange = dates.length ? `${dates[0]} → ${dates[dates.length - 1]} (${dates.length} days)` : "";

  return {
    format: "desktime", events, totalSeconds: total, rowCount: events.length,
    topTargets, labelTotals, dateRange, skipped, usesRowDates: true,
  };
}

function buildPreview(parsed) {
  if (!parsed) return "Select a file to see a preview.";
  const totalH = (parsed.totalSeconds / 3600).toFixed(1);
  const lines = [];
  if (parsed.format === "desktime") {
    lines.push(`Detected: DeskTime export`);
    lines.push(`${parsed.rowCount} events, ${totalH}h total`);
    if (parsed.dateRange) lines.push(`Range: ${parsed.dateRange}`);
    if (parsed.skipped) lines.push(`Skipped ${parsed.skipped} generic browser row(s) to avoid double-counting.`);
    const byLabel = Object.entries(parsed.labelTotals).sort((a, b) => b[1] - a[1]);
    if (byLabel.length) {
      lines.push("");
      lines.push("Auto-labeled from Productivity column:");
      for (const [l, s] of byLabel) lines.push(`  ${l.padEnd(10)} ${(s / 3600).toFixed(1)}h`);
    }
    const sorted = Object.entries(parsed.topTargets).sort((a, b) => b[1] - a[1]).slice(0, 8);
    if (sorted.length) {
      lines.push("");
      lines.push("Top apps / websites:");
      for (const [a, s] of sorted) lines.push(`  ${a.padEnd(24)} ${(s / 3600).toFixed(1)}h`);
    }
  } else {
    // Clockify
    lines.push(`Detected: Clockify summary export`);
    lines.push(`${parsed.events.length} rows, ${totalH}h total`);
    const topApps = {};
    for (const ev of parsed.events) topApps[ev.app] = (topApps[ev.app] || 0) + ev.seconds;
    const sorted = Object.entries(topApps).sort((a, b) => b[1] - a[1]).slice(0, 10);
    for (const [a, s] of sorted) lines.push(`  ${a.padEnd(16)} ${(s / 3600).toFixed(1)}h`);
  }
  return lines.join("\n");
}

async function onImportFile(e) {
  const f = e.target.files[0];
  if (!f) return;
  importFilename.textContent = f.name;

  const text = await f.text();
  const rows = parseCsv(text);
  if (rows.length < 2) {
    importPreview.textContent = "Empty or invalid CSV.";
    importGo.disabled = true;
    importParsed = null;
    return;
  }
  const format = detectFormat(rows[0]);
  if (!format) {
    importPreview.textContent =
      "Unrecognized CSV. Supported formats:\n" +
      "  • Clockify Summary (columns: Project, Description, Time (decimal))\n" +
      "  • DeskTime Export  (columns: Date, App/URL name, Productivity level, Time)";
    importGo.disabled = true;
    importParsed = null;
    return;
  }
  importParsed = format === "desktime" ? parseDeskTime(rows) : parseClockify(rows);

  // DeskTime has per-row dates and per-row labels; the anchor field is hidden
  // and the label field becomes an optional override.
  const anchorWrap = document.getElementById("import-anchor-wrap");
  if (anchorWrap) anchorWrap.style.display = format === "desktime" ? "none" : "";
  if (format === "desktime") {
    importLabel.value = ""; // default: use per-row productivity
    importLabel.placeholder = "blank = use DeskTime productivity per row";
  } else {
    importLabel.placeholder = "e.g. verimli (blank = none)";
    if (!importLabel.value) importLabel.value = "verimli";
    const fromName = parseFilenameDateClockify(f.name);
    if (fromName) importAnchor.value = fromName;
  }

  importPreview.textContent = buildPreview(importParsed);
  importGo.disabled = importParsed.events.length === 0;
}

function openImport() {
  importParsed = null;
  importFile.value = "";
  importFilename.textContent = "Choose a Clockify or DeskTime .csv…";
  importPreview.textContent = "Select a file to see a preview.";
  importGo.disabled = true;
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  importAnchor.value = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T23:59`;
  importLabel.value = "verimli";
  importLabel.placeholder = "e.g. verimli (blank = none)";
  const anchorWrap = document.getElementById("import-anchor-wrap");
  if (anchorWrap) anchorWrap.style.display = ""; // reset; hidden later for DeskTime
  importModal.classList.remove("hidden");
}

document.getElementById("import-csv").addEventListener("click", openImport);
document.getElementById("import-close").addEventListener("click", () => importModal.classList.add("hidden"));
document.getElementById("import-cancel").addEventListener("click", () => importModal.classList.add("hidden"));
importModal.addEventListener("click", (e) => { if (e.target === importModal) importModal.classList.add("hidden"); });
importFile.addEventListener("change", onImportFile);

importGo.addEventListener("click", async () => {
  if (!importParsed) return;
  importGo.disabled = true;

  const overrideLabel = (importLabel.value || "").trim() || null;
  let events;
  let titleTag;

  if (importParsed.usesRowDates) {
    // DeskTime: events already carry when_ts (per their own date) and a per-row
    // `label` from Productivity. An override label, if provided, wins.
    events = importParsed.events.map(ev => ({
      app: ev.app, domain: ev.domain || null, title: ev.title || null,
      seconds: ev.seconds, when_ts: ev.when_ts,
      label: overrideLabel ? null : (ev.label || null),
    }));
    titleTag = "[desktime]";
  } else {
    // Clockify: no per-row dates; stack events ending at the chosen anchor.
    const anchor = importAnchor.value ? new Date(importAnchor.value) : new Date();
    let cursorTs = anchor.getTime() / 1000;
    events = [];
    for (const ev of importParsed.events) {
      events.push({ app: ev.app, title: ev.title || null, seconds: ev.seconds, when_ts: cursorTs });
      cursorTs -= ev.seconds;
    }
    titleTag = "[clockify]";
  }

  const r = await api("POST", "/api/import", {
    events, apply_label: overrideLabel, title_tag: titleTag,
  });
  if (r.error) {
    importGo.disabled = false;
    return alert("Import failed: " + r.error);
  }
  importModal.classList.add("hidden");
  await refreshLabels();
  await load();
  const labelPart = r.labeled_targets
    ? ` Created ${r.labeled_targets} label rule(s).`
    : "";
  alert(`Imported ${r.inserted} events.${labelPart}`);
});

// ---------- settings ----------
const settingsModal = document.getElementById("settings-modal");
const settingsIdle = document.getElementById("settings-idle");
const settingsForm = document.getElementById("settings-form");
let settingsDefaults = { idle_threshold_default_s: 300 };

async function openSettings() {
  const s = await api("GET", "/api/settings");
  settingsDefaults = s;
  settingsIdle.value = (Number(s.idle_threshold_s) / 60).toFixed(1).replace(/\.0$/, "");
  document.getElementById("settings-poll").textContent = `${s.poll_interval_s}s`;
  document.getElementById("settings-http").textContent = `http://${s.http_host}:${s.http_port}`;
  document.getElementById("settings-data").textContent = s.data_dir;
  settingsModal.classList.remove("hidden");
  settingsIdle.focus();
}

document.getElementById("open-settings").addEventListener("click", openSettings);
document.getElementById("settings-close").addEventListener("click", () => settingsModal.classList.add("hidden"));
document.getElementById("settings-cancel").addEventListener("click", () => settingsModal.classList.add("hidden"));
settingsModal.addEventListener("click", (e) => { if (e.target === settingsModal) settingsModal.classList.add("hidden"); });

document.getElementById("settings-reset").addEventListener("click", () => {
  const def = Number(settingsDefaults.idle_threshold_default_s) || 300;
  settingsIdle.value = (def / 60).toFixed(1).replace(/\.0$/, "");
});

settingsForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const mins = parseFloat(settingsIdle.value);
  if (!isFinite(mins) || mins < 0.5) return alert("Idle threshold must be at least 0.5 minutes.");
  const seconds = Math.round(mins * 60);
  const r = await api("POST", "/api/settings", { idle_threshold_s: seconds });
  if (r.error) return alert("Save failed: " + r.error);
  settingsModal.classList.add("hidden");
  load();
});

// ---------- restart ----------
document.getElementById("restart-daemon").addEventListener("click", async () => {
  if (!confirm("Restart the Omrum daemon? In-progress spans are flushed; tracking resumes in a second.")) return;
  const btn = document.getElementById("restart-daemon");
  btn.disabled = true;
  btn.textContent = "Restarting…";
  try { await api("POST", "/api/restart"); } catch (_) { /* server is going away */ }
  // Poll health until the new daemon answers, then hard-reload so the UI picks up any code changes.
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const r = await fetch("/api/health", { cache: "no-store" });
      if (r.ok) {
        location.href = "/?r=" + Date.now();
        return;
      }
    } catch (_) { /* still down */ }
  }
  btn.disabled = false;
  btn.textContent = "↻ Restart";
  alert("Daemon didn't come back within 20s — check journalctl or /tmp/omrum-runtime.log.");
});

// ---------- main load ----------
async function load() {
  const qs = new URLSearchParams();
  qs.set("period", state.period);
  if (state.period === "range") {
    if (!state.range.start || !state.range.end) {
      const today = new Date();
      const weekAgo = new Date(Date.now() - 6 * 86400000);
      state.range = { start: dayStr(weekAgo), end: dayStr(today) };
    }
    qs.set("start", state.range.start);
    qs.set("end", state.range.end);
    document.getElementById("range-start").value = state.range.start;
    document.getElementById("range-end").value = state.range.end;
  } else if (state.anchor) {
    qs.set("anchor", state.anchor);
  }
  const data = await api("GET", "/api/summary?" + qs.toString());

  state.anchor = data.window.anchor;
  state.window = { start: data.window.start, end: data.window.end, label: data.window.label };
  document.getElementById("label-window").textContent = data.window.label;
  document.getElementById("active").textContent = fmt(data.totals.active_seconds);
  document.getElementById("idle").textContent = fmt(data.totals.idle_seconds);

  const stats = data.stats || {};
  document.getElementById("stat-productive").textContent = fmt(stats.productive_seconds || 0);
  document.getElementById("stat-unproductive").textContent = fmt(stats.unproductive_seconds || 0);
  const eff = stats.effectiveness || 0;
  document.getElementById("stat-effectiveness").textContent =
    eff > 0 ? `${(eff * 100).toFixed(0)}%` : "—";
  document.getElementById("stat-effectiveness-sub").textContent =
    stats.productivity > 0 ? `${(stats.productivity * 100).toFixed(0)}% of tracked` : "productive / (prod + unprod)";
  if (stats.peak && stats.peak.productive > 0) {
    const pd = new Date(stats.peak.t * 1000);
    const pad = (n) => String(n).padStart(2, "0");
    const bSec = stats.peak.bucket_s || 3600;
    const endD = new Date((stats.peak.t + bSec) * 1000);
    const label = bSec >= 86400
      ? pd.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })
      : `${pad(pd.getHours())}:${pad(pd.getMinutes())}–${pad(endD.getHours())}:${pad(endD.getMinutes())}`;
    document.getElementById("stat-peak").textContent = label;
    document.getElementById("stat-peak-sub").textContent = `${fmt(stats.peak.productive)} productive`;
  } else {
    document.getElementById("stat-peak").textContent = "—";
    document.getElementById("stat-peak-sub").textContent = "no productive time";
  }

  renderTimeline(data.timeline);
  renderLabelBars(document.getElementById("by-label"), data.by_label);
  renderGrouped(data.activity);

  document.getElementById("prev").dataset.anchor = data.window.prev;
  document.getElementById("next").dataset.anchor = data.window.next;
}

function setPeriod(p) {
  state.period = p;
  state.anchor = null;
  for (const b of document.querySelectorAll(".tabs button")) {
    b.classList.toggle("active", b.dataset.period === p);
  }
  document.getElementById("range-pickers").classList.toggle("hidden", p !== "range");
  load();
}

document.querySelectorAll(".tabs button").forEach((b) =>
  b.addEventListener("click", () => setPeriod(b.dataset.period)),
);

function applyNavAnchor(anchor) {
  if (state.period === "range") {
    const r = parseRangeAnchor(anchor);
    if (r) state.range = r;
  } else {
    state.anchor = anchor;
  }
  load();
}

document.getElementById("prev").addEventListener("click", (e) => applyNavAnchor(e.currentTarget.dataset.anchor));
document.getElementById("next").addEventListener("click", (e) => applyNavAnchor(e.currentTarget.dataset.anchor));
document.getElementById("today").addEventListener("click", () => {
  state.anchor = null;
  if (state.period === "range") {
    const today = new Date();
    const weekAgo = new Date(Date.now() - 6 * 86400000);
    state.range = { start: dayStr(weekAgo), end: dayStr(today) };
  }
  load();
});

// Range pickers
document.getElementById("range-apply").addEventListener("click", () => {
  const s = document.getElementById("range-start").value;
  const e = document.getElementById("range-end").value;
  if (!s || !e) return alert("Pick both start and end dates.");
  state.range = { start: s, end: e };
  state.period = "range";
  for (const b of document.querySelectorAll(".tabs button")) {
    b.classList.toggle("active", b.dataset.period === "range");
  }
  document.getElementById("range-pickers").classList.remove("hidden");
  load();
});
document.querySelectorAll(".range-presets button").forEach((b) =>
  b.addEventListener("click", () => {
    const n = parseInt(b.dataset.preset, 10);
    const today = new Date();
    const start = new Date(Date.now() - (n - 1) * 86400000);
    state.range = { start: dayStr(start), end: dayStr(today) };
    state.period = "range";
    for (const btn of document.querySelectorAll(".tabs button")) {
      btn.classList.toggle("active", btn.dataset.period === "range");
    }
    document.getElementById("range-pickers").classList.remove("hidden");
    load();
  })
);

// ---------- min-duration filter ----------
const minDurInput = document.getElementById("min-dur");
const savedMin = localStorage.getItem("omrum_min_dur_min");
if (savedMin !== null) minDurInput.value = savedMin;
let minDurTimer = null;
minDurInput.addEventListener("input", () => {
  const v = Math.max(0, parseFloat(minDurInput.value) || 0);
  localStorage.setItem("omrum_min_dur_min", String(v));
  clearTimeout(minDurTimer);
  minDurTimer = setTimeout(load, 120);
});

(async () => {
  await refreshLabels();
  await load();
  setInterval(load, 15000);
})();
