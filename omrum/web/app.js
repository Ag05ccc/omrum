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
    li.innerHTML = `
      <div class="fill" style="width:${pct}%"></div>
      <div class="row">
        ${kindChip}
        <span class="name">${escapeHtml(name)}</span>
        ${labelChip(label)}
        <span class="time">${fmt(it.seconds)}</span>
        ${more}
      </div>`;
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
      <div class="fill" style="width:${pct}%; background:${color}33"></div>
      <div class="row">
        <span class="chip-label" style="background:${color}">${escapeHtml(it.name)}</span>
        <span class="name"></span>
        <span class="time">${fmt(it.seconds)}</span>
      </div>`;
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

function parseFilenameDate(name) {
  // Clockify naming: ..._MM_DD_YYYY-MM_DD_YYYY.csv — return the END date
  const m = name.match(/(\d{2})_(\d{2})_(\d{4})(?!.*\d)/);
  if (!m) return null;
  const [_, mm, dd, yyyy] = m;
  return `${yyyy}-${mm}-${dd}T23:59`;
}

function pickDuration(row, headerIndex) {
  // prefer "Time (decimal)" for simple float parsing; fallback to HH:MM:SS
  const d = row[headerIndex.decimal];
  if (d !== undefined && !isNaN(parseFloat(d))) {
    return Math.round(parseFloat(d) * 3600);
  }
  const h = row[headerIndex.hms];
  if (h) {
    const parts = h.split(":").map(Number);
    if (parts.length === 3 && parts.every(n => !isNaN(n))) {
      return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }
  }
  return 0;
}

function buildPreview(parsed) {
  if (!parsed) return "Select a file to see a preview.";
  const topApps = {};
  for (const ev of parsed.events) {
    topApps[ev.app] = (topApps[ev.app] || 0) + ev.seconds;
  }
  const sorted = Object.entries(topApps).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const totalH = (parsed.totalSeconds / 3600).toFixed(1);
  const lines = [
    `${parsed.events.length} rows, ${totalH}h total`,
    ...sorted.map(([a, s]) => `  ${a.padEnd(16)} ${(s/3600).toFixed(1)}h`),
  ];
  if (parsed.events.length > sorted.length) lines.push(`  … and ${parsed.events.length - sorted.length} more rows`);
  return lines.join("\n");
}

async function onImportFile(e) {
  const f = e.target.files[0];
  if (!f) return;
  importFilename.textContent = f.name;
  const fromName = parseFilenameDate(f.name);
  if (fromName) importAnchor.value = fromName;

  const text = await f.text();
  const rows = parseCsv(text);
  if (rows.length < 2) {
    importPreview.textContent = "Empty or invalid CSV.";
    importGo.disabled = true;
    importParsed = null;
    return;
  }
  const header = rows[0].map(h => h.trim().toLowerCase());
  const hi = {
    project: header.indexOf("project"),
    description: header.indexOf("description"),
    hms: header.indexOf("time (h)"),
    decimal: header.indexOf("time (decimal)"),
  };
  if (hi.project < 0 || (hi.hms < 0 && hi.decimal < 0)) {
    importPreview.textContent = "Unrecognized CSV. Expected Clockify columns: Project, Description, Time (h), Time (decimal).";
    importGo.disabled = true;
    importParsed = null;
    return;
  }
  const events = [];
  let total = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const app = (r[hi.project] || "").trim();
    const title = hi.description >= 0 ? (r[hi.description] || "").trim() : "";
    const sec = pickDuration(r, hi);
    if (!app || sec <= 0) continue;
    events.push({ app, title, seconds: sec });
    total += sec;
  }
  importParsed = { events, totalSeconds: total, rowCount: events.length };
  importPreview.textContent = buildPreview(importParsed);
  importGo.disabled = events.length === 0;
}

function openImport() {
  importParsed = null;
  importFile.value = "";
  importFilename.textContent = "Choose a Clockify summary .csv…";
  importPreview.textContent = "Select a file to see a preview.";
  importGo.disabled = true;
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  importAnchor.value = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T23:59`;
  importLabel.value = "verimli";
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
  // Place events ending at the anchor, stacking backwards so they never overlap.
  const anchor = importAnchor.value ? new Date(importAnchor.value) : new Date();
  let cursorTs = anchor.getTime() / 1000;
  const out = [];
  for (const ev of importParsed.events) {
    out.push({ app: ev.app, title: ev.title || null, seconds: ev.seconds, when_ts: cursorTs });
    cursorTs -= ev.seconds;
  }
  const apply = (importLabel.value || "").trim() || null;
  const r = await api("POST", "/api/import", { events: out, apply_label: apply, title_tag: "[clockify]" });
  if (r.error) {
    importGo.disabled = false;
    return alert("Import failed: " + r.error);
  }
  importModal.classList.add("hidden");
  await refreshLabels();
  await load();
  alert(`Imported ${r.inserted} events. ${r.labeled_targets ? `Labeled ${r.labeled_targets} projects as "${apply}".` : ""}`);
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
  document.getElementById("total").textContent = fmt(data.totals.total_seconds);

  renderLabelBars(document.getElementById("by-label"), data.by_label);
  renderBars(document.getElementById("activity"), data.activity, "label", "kind", true);
  renderBars(document.getElementById("apps"), data.apps, "app", null, true);
  renderBars(document.getElementById("domains"), data.domains, "domain", null, true);

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

(async () => {
  await refreshLabels();
  await load();
  setInterval(load, 15000);
})();
