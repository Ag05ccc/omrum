// ============================================================
// Omrum dashboard — vanilla JS (ES module)
// ============================================================

// ---------- formatters & helpers ----------
const pad = (n) => String(n).padStart(2, "0");

const fmt = (sec) => {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
};
const fmtShort = (sec) => {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
};
const fmtHm = (ts) => {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const dayStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const escapeHtml = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

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

function fmtDelta(curr, base) {
  if (!base || !isFinite(base) || base <= 0) return null;
  const d = (curr - base) / base;
  return d;
}
function deltaLabel(d) {
  if (d === null || d === undefined || !isFinite(d)) return { cls: "flat", text: "" };
  const pct = Math.round(d * 100);
  if (pct === 0) return { cls: "flat", text: "0%" };
  return { cls: pct > 0 ? "up" : "down", text: `${pct > 0 ? "+" : ""}${pct}%` };
}

// Classify an activity item for the "Where time went" grouped view.
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
  { cat: "productive",   title: "Productive" },
  { cat: "unproductive", title: "Unproductive" },
  { cat: "neutral",      title: "Neutral" },
  { cat: "unlabeled",    title: "Unlabeled" },
];

// ---------- state ----------
const state = {
  period: "day",
  anchor: null,
  range: { start: null, end: null },
  labels: [],
  window: { start: 0, end: 0, label: "" },
  pickerTarget: null,
  rowTarget: null,
  sort: "duration",
  categoryFilter: null,        // label_id or "unlabeled" or null
  comparisons: null,           // { sparklines: {active:[],productive:[]...}, avgs: {...}, periodAvg: {...} }
  lastData: null,
  othersExpanded: {},          // per-category expansion state
  peakTime: null,              // ts of peak productive bucket (for ring glow)
  bucketMin: {},               // { day: 5, week: null, ... } — null means auto
};

// Load per-period candle overrides from localStorage on startup.
try {
  const raw = localStorage.getItem("omrum_bucket_min");
  if (raw) state.bucketMin = JSON.parse(raw) || {};
} catch (_) { state.bucketMin = {}; }

// ============================================================
// Tabs — sliding pill
// ============================================================
function movePill() {
  const nav = document.querySelector(".tabs");
  const pill = nav.querySelector(".tabs-pill");
  const active = nav.querySelector("button.active");
  if (!active) return;
  const navRect = nav.getBoundingClientRect();
  const btnRect = active.getBoundingClientRect();
  pill.style.width = `${btnRect.width}px`;
  pill.style.transform = `translateX(${btnRect.left - navRect.left - 4}px)`;
}
window.addEventListener("resize", movePill);

function setActiveTab(period) {
  for (const b of document.querySelectorAll(".tabs button")) {
    const on = b.dataset.period === period;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
  }
  movePill();
}

// ============================================================
// Hero: radial ring + stat grid
// ============================================================
function renderHero(data, comparisons) {
  const stats = data.stats || {};
  const totals = data.totals || {};
  const productive = stats.productive_seconds || 0;
  const unproductive = stats.unproductive_seconds || 0;
  const denom = productive + unproductive;
  const score = denom > 0 ? Math.round((productive / denom) * 100) : null;

  // ring
  const circumference = 2 * Math.PI * 52; // ≈ 326.73
  const ringFill = document.getElementById("ring-fill");
  const ringOff = score === null
    ? circumference
    : circumference * (1 - score / 100);
  ringFill.style.strokeDashoffset = ringOff.toFixed(1);

  const scoreEl = document.getElementById("score-value");
  scoreEl.textContent = score === null ? "—" : String(score);

  // narrative + badge
  const badge = document.getElementById("score-badge");
  const narrative = document.getElementById("score-narrative");
  if (score === null) {
    badge.className = "badge badge-muted";
    badge.textContent = "no tracked time";
    narrative.innerHTML = `Log some time and this panel will summarise your day.`;
  } else {
    const avgScore = comparisons?.avgs?.score;
    if (avgScore !== undefined && avgScore !== null) {
      const diff = score - avgScore;
      const cls = diff > 1 ? "badge-up" : diff < -1 ? "badge-down" : "badge-muted";
      badge.className = `badge ${cls}`;
      badge.textContent =
        diff > 1 ? `↑ ${Math.abs(diff)} pts` :
        diff < -1 ? `↓ ${Math.abs(diff)} pts` :
        `≈ trend`;
      const word = diff > 1 ? `<span class="up">above</span>` :
                   diff < -1 ? `<span class="down">below</span>` :
                               `on track with`;
      narrative.innerHTML =
        `<strong>${score}%</strong> effectiveness — ${word} your ` +
        `${comparisons.avgs.windowLabel} average of <strong>${Math.round(avgScore)}%</strong>.`;
    } else {
      badge.className = "badge badge-muted";
      badge.textContent = `${score}%`;
      narrative.innerHTML =
        `<strong>${score}%</strong> effectiveness. ` +
        `Productive time out of productive + unproductive.`;
    }
  }

  // facts
  document.getElementById("score-productive").textContent = fmt(productive);
  document.getElementById("score-unproductive").textContent = fmt(unproductive);

  const peak = stats.peak;
  if (peak && peak.productive > 0) {
    const pd = new Date(peak.t * 1000);
    const bSec = peak.bucket_s || 3600;
    const endD = new Date((peak.t + bSec) * 1000);
    const peakLabel = bSec >= 86400
      ? pd.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })
      : `${pad(pd.getHours())}:${pad(pd.getMinutes())}–${pad(endD.getHours())}:${pad(endD.getMinutes())}`;
    document.getElementById("score-peak").textContent = peakLabel;
    state.peakTime = peak.t;
  } else {
    document.getElementById("score-peak").textContent = "—";
    state.peakTime = null;
  }

  // stat tiles
  const tileValues = {
    active:       totals.active_seconds || 0,
    productive:   productive,
    unproductive: unproductive,
    idle:         totals.idle_seconds || 0,
  };
  document.getElementById("stat-active").textContent       = fmtShort(tileValues.active);
  document.getElementById("stat-productive").textContent   = fmtShort(tileValues.productive);
  document.getElementById("stat-unproductive").textContent = fmtShort(tileValues.unproductive);
  document.getElementById("stat-idle").textContent         = fmtShort(tileValues.idle);

  // sparklines + deltas
  for (const tile of document.querySelectorAll(".stat-tile")) {
    const k = tile.dataset.k;
    const series = comparisons?.sparklines?.[k];
    const svg = tile.querySelector("svg.spark");
    const trendEl = tile.querySelector(".trend");
    if (series && series.length >= 2) {
      drawSpark(svg, series);
      const avg = comparisons.avgs[k];
      const curr = tileValues[k];
      const d = fmtDelta(curr, avg);
      const lab = deltaLabel(d);
      trendEl.className = `trend ${lab.cls}`;
      trendEl.textContent = lab.text;
    } else {
      svg.innerHTML = "";
      trendEl.className = "trend flat";
      trendEl.textContent = "";
    }
  }
}

function drawSpark(svg, series) {
  svg.innerHTML = "";
  const W = 100, H = 24, PAD = 2;
  const max = Math.max(1, ...series);
  const step = (W - PAD * 2) / Math.max(1, series.length - 1);
  const pts = series.map((v, i) => {
    const x = PAD + i * step;
    const y = H - PAD - (v / max) * (H - PAD * 2);
    return [x, y];
  });
  const d = pts.map((p, i) => (i === 0 ? "M" : "L") + p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" ");
  const fillD = d + ` L ${(W - PAD).toFixed(1)},${(H - PAD).toFixed(1)} L ${PAD.toFixed(1)},${(H - PAD).toFixed(1)} Z`;

  const ns = "http://www.w3.org/2000/svg";
  const fill = document.createElementNS(ns, "path");
  fill.setAttribute("d", fillD);
  fill.setAttribute("fill", "currentColor");
  fill.setAttribute("opacity", "0.14");
  svg.appendChild(fill);

  const line = document.createElementNS(ns, "path");
  line.setAttribute("d", d);
  line.setAttribute("fill", "none");
  line.setAttribute("stroke", "currentColor");
  line.setAttribute("stroke-width", "1.4");
  line.setAttribute("stroke-linejoin", "round");
  line.setAttribute("stroke-linecap", "round");
  line.setAttribute("opacity", "0.9");
  svg.appendChild(line);

  // last-point dot
  const last = pts[pts.length - 1];
  const dot = document.createElementNS(ns, "circle");
  dot.setAttribute("cx", last[0].toFixed(1));
  dot.setAttribute("cy", last[1].toFixed(1));
  dot.setAttribute("r", "1.9");
  dot.setAttribute("fill", "currentColor");
  svg.appendChild(dot);
}

// ============================================================
// Timeline
// ============================================================
function renderTimeline(timeline, windowInfo, isTodayView) {
  const el = document.getElementById("timeline");
  const axisEl = document.getElementById("timeline-axis");
  const overlayEl = document.getElementById("timeline-overlay");
  const hintEl = document.getElementById("timeline-hint");
  el.innerHTML = "";
  axisEl.innerHTML = "";
  overlayEl.innerHTML = "";
  el.classList.remove("animate");

  if (!timeline || !timeline.buckets || !timeline.buckets.length) {
    el.innerHTML = `<div style="color:var(--muted); padding: 30px; text-align:center; flex:1;">No data yet.</div>`;
    return;
  }
  const bucketS = timeline.bucket_s;
  const isMinute = bucketS < 3600;
  const isHourly = bucketS === 3600;
  const isMultiHour = bucketS > 3600 && bucketS < 86400;
  const isDaily = bucketS >= 86400;
  el.classList.toggle("dense", isMinute);
  hintEl.textContent = isMinute
    ? `Each column is ${Math.round(bucketS / 60)} minutes. Hover for details.`
    : isHourly
      ? "Each column is one hour. Hover for details."
      : isMultiHour
        ? `Each column is ${Math.round(bucketS / 3600)} hours.`
        : "Each column is one day.";

  // find peak productive bucket
  let peakIdx = -1, peakVal = 0;
  timeline.buckets.forEach((b, i) => {
    if (b.productive > peakVal) { peakVal = b.productive; peakIdx = i; }
  });
  const avgProductive = timeline.buckets.reduce((s, b) => s + b.productive, 0) / timeline.buckets.length;

  const frag = document.createDocumentFragment();
  timeline.buckets.forEach((b, i) => {
    const total = b.productive + b.unproductive + b.neutral + b.unlabeled + b.idle;
    const fill = Math.min(1, total / bucketS);
    const fillPct = fill * 100;
    const col = document.createElement("div");
    col.className = "bucket";
    if (total <= 0) col.classList.add("empty");
    if (i === peakIdx && peakVal > 0) col.classList.add("peak");

    const seg = (cls, sec) => {
      if (sec <= 0) return "";
      const pct = (sec / Math.max(total, 1)) * fillPct;
      return `<div class="seg ${cls}" style="height:${pct}%"></div>`;
    };
    const body =
      seg("productive",   b.productive) +
      seg("neutral",      b.neutral) +
      seg("unlabeled",    b.unlabeled) +
      seg("unproductive", b.unproductive) +
      seg("idle",         b.idle);

    const when = new Date(b.t * 1000);
    const whenEnd = new Date((b.t + bucketS) * 1000);
    const tipHead = isDaily
      ? when.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })
      : isMinute
        ? `${pad(when.getHours())}:${pad(when.getMinutes())} – ${pad(whenEnd.getHours())}:${pad(whenEnd.getMinutes())}`
        : isMultiHour
          ? `${pad(when.getHours())}:00 – ${pad((when.getHours() + Math.round(bucketS / 3600)) % 24)}:00`
          : `${pad(when.getHours())}:00 – ${pad((when.getHours() + 1) % 24)}:00`;
    const topItems = Array.isArray(b.top_items) ? b.top_items : [];
    const topRows = topItems.map((it) => `
      <div class="tl-row">
        <span class="d"><i class="sw" style="display:inline-block;width:8px;height:8px;border-radius:2px;background:var(--c-${it.cat});margin-right:6px;vertical-align:middle"></i>${escapeHtml(it.label)}</span>
        <span class="v">${fmt(it.seconds)}</span>
      </div>`).join("");
    const idleRow = b.idle > 0
      ? `<div class="tl-row"><span class="d"><i class="sw" style="display:inline-block;width:8px;height:8px;border-radius:2px;background:var(--c-idle);margin-right:6px;vertical-align:middle"></i>idle</span><span class="v">${fmt(b.idle)}</span></div>`
      : "";
    const body2 = topRows + idleRow ||
      `<div class="tl-row" style="color:var(--muted)"><span class="d">No activity</span><span class="v"></span></div>`;
    const unit = isDaily ? "day" : isMultiHour ? "window" : isMinute ? "slot" : "hour";
    const tip = `
      <div class="tl-tip">
        <div class="tl-title">${escapeHtml(tipHead)}</div>
        ${body2}
        <div class="tl-foot">${Math.round(fill * 100)}% of ${unit} tracked</div>
      </div>`;
    col.innerHTML = body + tip;
    frag.appendChild(col);
  });
  el.appendChild(frag);
  // trigger entrance animation
  requestAnimationFrame(() => el.classList.add("animate"));

  // average productive reference line (skip when bar is super-short and noisy)
  if ((isHourly || isMinute) && avgProductive > 0) {
    const yPct = (avgProductive / bucketS) * 100; // height from bottom
    if (yPct >= 4 && yPct <= 96) {
      const line = document.createElement("div");
      line.className = "avg-line";
      line.style.bottom = `${yPct}%`;
      overlayEl.appendChild(line);
    }
  }

  // "now" indicator
  if (isTodayView) {
    const nowTs = Date.now() / 1000;
    if (nowTs >= windowInfo.start && nowTs <= windowInfo.end) {
      const frac = (nowTs - windowInfo.start) / (windowInfo.end - windowInfo.start);
      if (frac >= 0 && frac <= 1) {
        const line = document.createElement("div");
        line.className = "now-line";
        line.style.left = `calc(${(frac * 100).toFixed(2)}% - 1px)`;
        overlayEl.appendChild(line);
      }
    }
  }

  // axis
  const n = timeline.buckets.length;
  const target = Math.min(8, n);
  const step = Math.max(1, Math.round(n / target));
  for (let i = 0; i < n; i++) {
    const span = document.createElement("span");
    if (i % step === 0 || i === n - 1) {
      const when = new Date(timeline.buckets[i].t * 1000);
      span.textContent = isDaily
        ? when.toLocaleDateString(undefined, { month: "numeric", day: "numeric" })
        : `${pad(when.getHours())}`;
    }
    axisEl.appendChild(span);
  }
}

// ============================================================
// By category — stacked bar + table
// ============================================================
function renderCategory(byLabel, comparisons) {
  const stackedEl = document.getElementById("stacked-bar");
  const tableEl   = document.getElementById("category-table");
  stackedEl.innerHTML = "";
  tableEl.innerHTML = "";
  const total = byLabel.reduce((s, x) => s + (x.seconds || 0), 0);
  if (!total) {
    stackedEl.classList.add("empty");
    tableEl.innerHTML = `<div class="group-empty">No data yet.</div>`;
    return;
  }
  stackedEl.classList.remove("empty");

  // build stacked bar
  const fragBar = document.createDocumentFragment();
  for (const it of byLabel) {
    const pct = ((it.seconds || 0) / total) * 100;
    if (pct <= 0) continue;
    const seg = document.createElement("div");
    seg.className = "seg";
    const key = it.label_id === null || it.label_id === undefined ? "unlabeled" : String(it.label_id);
    seg.dataset.key = key;
    seg.style.flex = `${pct} 0 0`;
    seg.style.background = it.color || "var(--c-unlabeled)";
    seg.title = `${it.name} · ${fmt(it.seconds)} (${pct.toFixed(1)}%)`;
    if (state.categoryFilter === key) seg.classList.add("selected");
    seg.addEventListener("click", () => toggleCategoryFilter(key));
    fragBar.appendChild(seg);
  }
  stackedEl.appendChild(fragBar);

  // build table
  const fragTbl = document.createDocumentFragment();
  for (const it of byLabel) {
    const key = it.label_id === null || it.label_id === undefined ? "unlabeled" : String(it.label_id);
    const pct = ((it.seconds || 0) / total) * 100;
    const row = document.createElement("div");
    row.className = "cat-row";
    if (state.categoryFilter === key) row.classList.add("selected");
    row.dataset.key = key;

    // delta vs comparison avg (per-label)
    let deltaHtml = "";
    const avgForLabel = comparisons?.perLabelAvg?.[it.name?.toLowerCase()];
    if (avgForLabel > 0) {
      const d = fmtDelta(it.seconds || 0, avgForLabel);
      const lab = deltaLabel(d);
      if (lab.text) deltaHtml = `<span class="trend ${lab.cls}">${lab.text}</span>`;
    }

    row.innerHTML = `
      <span class="dot" style="background:${it.color || "var(--c-unlabeled)"}"></span>
      <span class="cat-name">${escapeHtml(it.name)}</span>
      <span class="cat-time">${fmt(it.seconds || 0)}</span>
      <span class="cat-pct">${pct.toFixed(1)}%</span>
      <span class="cat-delta">${deltaHtml}</span>
    `;
    row.addEventListener("click", () => toggleCategoryFilter(key));
    fragTbl.appendChild(row);
  }
  tableEl.appendChild(fragTbl);

  document.getElementById("category-clear").classList.toggle("hidden", state.categoryFilter === null);
  document.getElementById("category-hint").textContent =
    state.categoryFilter
      ? "Filtering rows below. Click again to clear."
      : "Share of tracked time per label. Click a row to filter below.";
}

function toggleCategoryFilter(key) {
  state.categoryFilter = state.categoryFilter === key ? null : key;
  if (state.lastData) {
    renderCategory(state.lastData.by_label || [], state.comparisons);
    renderGrouped(state.lastData.activity || []);
  }
}

// ============================================================
// Where time went
// ============================================================
function faviconUrl(domain) {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32`;
}

function appInitial(name) {
  return (name || "?").trim().charAt(0).toUpperCase() || "·";
}

function matchesFilter(item) {
  if (state.categoryFilter === null) return true;
  const cat = categoryOf(item);
  if (state.categoryFilter === "unlabeled") return cat === "unlabeled";
  // numeric label_id key
  const id = item.assigned ? item.assigned.id : null;
  if (id !== null && String(id) === state.categoryFilter) return true;
  return false;
}

function renderGrouped(items) {
  const el = document.getElementById("grouped");
  el.innerHTML = "";
  const minSec = (parseFloat(document.getElementById("min-dur").value) || 0) * 60;
  const filtered = items.filter((it) => matchesFilter(it));

  if (!filtered.length) {
    el.innerHTML = `<div class="group-empty">No activity to show${state.categoryFilter ? " in this category" : ""}.</div>`;
    return;
  }

  const buckets = { productive: [], unproductive: [], neutral: [], unlabeled: [] };
  for (const it of filtered) buckets[categoryOf(it)].push(it);

  const frag = document.createDocumentFragment();
  for (const { cat, title } of GROUP_META) {
    const rows = buckets[cat];
    if (!rows.length) continue;

    // sort
    if (state.sort === "duration") {
      rows.sort((a, b) => (b.seconds || 0) - (a.seconds || 0));
    } else {
      rows.sort((a, b) => (a.label || "").localeCompare(b.label || ""));
    }

    const visible = [];
    const hidden = [];
    for (const it of rows) {
      if ((it.seconds || 0) >= minSec) visible.push(it);
      else hidden.push(it);
    }

    const total = rows.reduce((s, x) => s + (x.seconds || 0), 0);
    const maxSec = Math.max(1, ...rows.map((x) => x.seconds || 0));

    const group = document.createElement("div");
    group.className = "group";
    const head = document.createElement("div");
    head.className = "group-head";
    head.innerHTML = `
      <span class="pill ${cat}">${escapeHtml(title)}</span>
      <span class="group-count">${rows.length} ${rows.length === 1 ? "item" : "items"}</span>
      <span class="group-total">${fmt(total)}</span>
    `;
    group.appendChild(head);

    const list = document.createElement("div");
    list.className = "group-list";
    const expandKey = cat;
    const isExpanded = !!state.othersExpanded[expandKey];
    const showRows = isExpanded ? [...visible, ...hidden] : visible;

    for (const it of showRows) {
      list.appendChild(makeActivityRow(it, cat, maxSec, total));
    }
    if (!isExpanded && hidden.length) {
      const hiddenTotal = hidden.reduce((s, x) => s + (x.seconds || 0), 0);
      const more = document.createElement("div");
      more.className = "wrow others";
      more.innerHTML = `
        <span class="icon app">+</span>
        <span class="name">+ ${hidden.length} more under ${Math.round(minSec / 60)}m</span>
        <span class="mini-bar"></span>
        <span class="time">${fmt(hiddenTotal)}</span>
        <span class="pct">show</span>
        <span></span>
      `;
      more.addEventListener("click", () => {
        state.othersExpanded[expandKey] = true;
        renderGrouped(items);
      });
      list.appendChild(more);
    } else if (isExpanded && hidden.length) {
      const collapse = document.createElement("div");
      collapse.className = "wrow others";
      collapse.innerHTML = `
        <span class="icon app">−</span>
        <span class="name">Collapse small items</span>
        <span class="mini-bar"></span>
        <span class="time"></span>
        <span class="pct">hide</span>
        <span></span>
      `;
      collapse.addEventListener("click", () => {
        state.othersExpanded[expandKey] = false;
        renderGrouped(items);
      });
      list.appendChild(collapse);
    }

    group.appendChild(list);
    frag.appendChild(group);
  }
  el.appendChild(frag);
}

// Strip redundant browser suffixes from X11 window titles so the tooltip
// doesn't repeat " - Google Chrome" on every row.
const BROWSER_SUFFIXES = [
  " - Google Chrome", " — Google Chrome",
  " - Chromium", " - Mozilla Firefox",
  " - Brave", " - Microsoft Edge", " - Opera", " - Vivaldi",
];
function cleanTitle(t) {
  let s = String(t || "").trim();
  for (const suf of BROWSER_SUFFIXES) {
    if (s.endsWith(suf)) { s = s.slice(0, -suf.length); break; }
  }
  return s;
}

function makeActivityRow(it, cat, maxSec, groupTotal) {
  const div = document.createElement("div");
  div.className = `wrow ${cat}`;
  const pct = groupTotal > 0 ? ((it.seconds || 0) / groupTotal) * 100 : 0;
  const barPct = Math.max(2, ((it.seconds || 0) / maxSec) * 100);

  let iconHtml;
  if (it.kind === "web") {
    iconHtml = `<span class="icon"><img src="${faviconUrl(it.label)}" alt="" loading="lazy" onerror="this.remove()"/></span>`;
  } else {
    iconHtml = `<span class="icon app">${escapeHtml(appInitial(it.label))}</span>`;
  }

  const assigned = it.assigned
    ? `<span class="sub">${escapeHtml(it.assigned.name)}</span>`
    : "";

  const titles = Array.isArray(it.top_titles) ? it.top_titles : [];
  let tipHtml = "";
  if (titles.length) {
    const rows = titles.map((t) => `
      <div class="tl-row">
        <span class="d">${escapeHtml(cleanTitle(t.title) || "(untitled)")}</span>
        <span class="v">${fmt(t.seconds)}</span>
      </div>`).join("");
    const coverage = titles.reduce((s, t) => s + (t.seconds || 0), 0);
    const coveragePct = it.seconds > 0 ? Math.round((coverage / it.seconds) * 100) : 0;
    tipHtml = `
      <div class="wrow-tip">
        <div class="tl-title">${escapeHtml(it.label)} · top windows</div>
        ${rows}
        <div class="tl-foot">${coveragePct}% of ${fmt(it.seconds)} shown</div>
      </div>`;
  }

  div.innerHTML = `
    ${iconHtml}
    <span class="name" title="${escapeHtml(it.label)}">${escapeHtml(it.label)}${assigned}</span>
    <span class="mini-bar"><span class="fill" style="width:${barPct}%"></span></span>
    <span class="time">${fmt(it.seconds)}</span>
    <span class="pct">${pct.toFixed(0)}%</span>
    <button class="more" title="Actions" aria-label="Actions">⋯</button>
    ${tipHtml}
  `;
  const tt = it.kind === "web" ? "domain" : "app";
  div.addEventListener("click", (e) => {
    if (e.target.closest(".more")) return;
    openPicker(e.currentTarget, tt, it.label, it.assigned ? it.assigned.id : null);
  });
  div.querySelector(".more").addEventListener("click", (e) => {
    e.stopPropagation();
    openRowMenu(e.currentTarget, tt, it.label);
  });
  return div;
}

// ============================================================
// Comparisons — fetch trailing window summary, build sparklines
// ============================================================
async function loadComparisons(windowInfo) {
  // only day/week/month/year make sense for comparison
  if (state.period === "range") { state.comparisons = null; return; }
  try {
    const DAY = 86400;
    const spanS = Math.max(DAY, windowInfo.end - windowInfo.start);
    const spanDays = Math.round(spanS / DAY);
    const samples = 7;                 // 7 trailing comparable periods
    const end = new Date(windowInfo.end * 1000 - 1000);
    const start = new Date(end.getTime() - (samples * spanDays - 1) * DAY * 1000);
    const qs = new URLSearchParams({
      period: "range",
      start: dayStr(start),
      end: dayStr(end),
    });
    const data = await api("GET", "/api/summary?" + qs);
    const buckets = data?.timeline?.buckets || [];
    const bucketS = data?.timeline?.bucket_s || DAY;

    // bucket into `samples` consecutive period-sized bins
    const binSec = spanDays * DAY;
    const bins = Array.from({ length: samples }, () => ({
      active: 0, productive: 0, unproductive: 0, neutral: 0, unlabeled: 0, idle: 0,
    }));
    const winStart = start.getTime() / 1000;
    for (const b of buckets) {
      const idx = Math.floor((b.t - winStart) / binSec);
      if (idx < 0 || idx >= samples) continue;
      bins[idx].productive   += b.productive;
      bins[idx].unproductive += b.unproductive;
      bins[idx].neutral      += b.neutral;
      bins[idx].unlabeled    += b.unlabeled;
      bins[idx].idle         += b.idle;
      bins[idx].active       += b.productive + b.unproductive + b.neutral + b.unlabeled;
    }

    const sparklines = {
      active:       bins.map((b) => b.active),
      productive:   bins.map((b) => b.productive),
      unproductive: bins.map((b) => b.unproductive),
      idle:         bins.map((b) => b.idle),
    };
    const avg = (arr) => arr.reduce((s, v) => s + v, 0) / Math.max(1, arr.length);
    const avgs = {
      active:       avg(sparklines.active),
      productive:   avg(sparklines.productive),
      unproductive: avg(sparklines.unproductive),
      idle:         avg(sparklines.idle),
    };
    // Effectiveness baseline: time-weighted, matching the single-window
    // formula in server.py. A per-bin mean over-weights short periods
    // (e.g. a 5-min bin with 100% productive dominates a 40h bin at 50%).
    const totalP = bins.reduce((s, b) => s + b.productive, 0);
    const totalU = bins.reduce((s, b) => s + b.unproductive, 0);
    avgs.score = (totalP + totalU) > 0 ? (totalP / (totalP + totalU)) * 100 : null;

    // windowLabel for narrative
    const windowLabel = ({
      day:   "7-day",
      week:  "7-week",
      month: "7-month",
      year:  "7-year",
    }[state.period]) || "recent";
    avgs.windowLabel = windowLabel;

    // per-label averages — keyed by label name (lowercased)
    const perLabelAvg = {};
    // Build by dividing the by_label total by samples (rough per-period avg).
    for (const lb of data.by_label || []) {
      const nm = (lb.name || "").toLowerCase();
      perLabelAvg[nm] = (lb.seconds || 0) / samples;
    }

    state.comparisons = { sparklines, avgs, perLabelAvg };
  } catch (_) {
    state.comparisons = null;
  }
}

// ============================================================
// Load
// ============================================================
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
  const override = state.bucketMin[state.period];
  if (override && override > 0) qs.set("bucket_min", String(override));

  const data = await api("GET", "/api/summary?" + qs.toString());
  state.lastData = data;
  state.anchor = data.window.anchor;
  state.window = { start: data.window.start, end: data.window.end, label: data.window.label };
  document.getElementById("label-window").textContent = data.window.label;
  syncCandleInput(data.timeline);

  // render primary content with whatever comparisons we currently have
  renderHero(data, state.comparisons);
  const nowTs = Date.now() / 1000;
  const isTodayView = state.period === "day" && nowTs >= data.window.start && nowTs <= data.window.end;
  renderTimeline(data.timeline, data.window, isTodayView);
  renderCategory(data.by_label || [], state.comparisons);
  renderGrouped(data.activity || []);

  document.getElementById("prev").dataset.anchor = data.window.prev;
  document.getElementById("next").dataset.anchor = data.window.next;

  // async: load comparisons and re-render hero/category when ready
  loadComparisons(data.window).then(() => {
    if (!state.lastData) return;
    renderHero(state.lastData, state.comparisons);
    renderCategory(state.lastData.by_label || [], state.comparisons);
  });
}

// ============================================================
// Period & range navigation
// ============================================================
function setPeriod(p) {
  state.period = p;
  state.anchor = null;
  setActiveTab(p);
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

document.getElementById("range-apply").addEventListener("click", () => {
  const s = document.getElementById("range-start").value;
  const e = document.getElementById("range-end").value;
  if (!s || !e) return alert("Pick both start and end dates.");
  state.range = { start: s, end: e };
  state.period = "range";
  setActiveTab("range");
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
    setActiveTab("range");
    document.getElementById("range-pickers").classList.remove("hidden");
    load();
  })
);

// ============================================================
// Sort toggle
// ============================================================
document.querySelectorAll(".seg-small button[data-sort]").forEach((b) => {
  b.addEventListener("click", () => {
    for (const s of document.querySelectorAll(".seg-small button[data-sort]")) {
      s.classList.toggle("active", s === b);
    }
    state.sort = b.dataset.sort;
    if (state.lastData) renderGrouped(state.lastData.activity || []);
  });
});

document.getElementById("category-clear").addEventListener("click", () => {
  state.categoryFilter = null;
  if (state.lastData) {
    renderCategory(state.lastData.by_label || [], state.comparisons);
    renderGrouped(state.lastData.activity || []);
  }
});

// ============================================================
// Label picker
// ============================================================
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
function closePicker() { picker.classList.add("hidden"); state.pickerTarget = null; }

async function assign(label_id) {
  if (!state.pickerTarget) return;
  const { target_type, target } = state.pickerTarget;
  await api("POST", "/api/assign", { target_type, target, label_id });
  closePicker();
  load();
}
document.getElementById("picker-clear").addEventListener("click", () => assign(null));

// ============================================================
// Row menu
// ============================================================
const rowmenu = document.getElementById("rowmenu");
const rowmenuTarget = document.getElementById("rowmenu-target");

function openRowMenu(anchorEl, target_type, target) {
  closeAllPopovers();
  state.rowTarget = { target_type, target };
  rowmenuTarget.textContent = `${target_type}: ${target}`;
  positionPopover(rowmenu, anchorEl);
  rowmenu.classList.remove("hidden");
}
function closeRowMenu() { rowmenu.classList.add("hidden"); state.rowTarget = null; }

async function deleteRow(scoped) {
  if (!state.rowTarget) return;
  const { target_type, target } = state.rowTarget;
  const label = state.window.label || "this period";
  const msg = scoped
    ? `Delete all time for "${target}" in ${label}?`
    : `Delete ALL time for "${target}" across ALL history? This cannot be undone.`;
  if (!confirm(msg)) return;
  const body = { [target_type === "app" ? "app" : "domain"]: target };
  if (scoped) { body.start_ts = state.window.start; body.end_ts = state.window.end; }
  await api("DELETE", "/api/events", body);
  closeRowMenu();
  load();
}
document.getElementById("rowmenu-del-period").addEventListener("click", () => deleteRow(true));
document.getElementById("rowmenu-del-all").addEventListener("click", () => deleteRow(false));

// ============================================================
// Overflow menu + help menu
// ============================================================
const overflow = document.getElementById("overflow-menu");
const helpMenu = document.getElementById("help-menu");

function openOverflow(anchorEl) {
  closeAllPopovers();
  positionPopover(overflow, anchorEl, { align: "right" });
  overflow.classList.remove("hidden");
}
function openHelp(anchorEl) {
  closeAllPopovers();
  positionPopover(helpMenu, anchorEl, { align: "right" });
  helpMenu.classList.remove("hidden");
}

document.getElementById("head-overflow").addEventListener("click", (e) => {
  e.stopPropagation();
  if (overflow.classList.contains("hidden")) openOverflow(e.currentTarget);
  else overflow.classList.add("hidden");
});
document.getElementById("help-keys").addEventListener("click", (e) => {
  e.stopPropagation();
  if (helpMenu.classList.contains("hidden")) openHelp(e.currentTarget);
  else helpMenu.classList.add("hidden");
});

// Overflow items — route to existing modals/handlers
document.getElementById("ov-labels").addEventListener("click", async () => {
  overflow.classList.add("hidden");
  await refreshLabels();
  renderLabelList();
  modal.classList.remove("hidden");
});
document.getElementById("ov-settings").addEventListener("click", () => {
  overflow.classList.add("hidden");
  openSettings();
});
document.getElementById("ov-restart").addEventListener("click", () => {
  overflow.classList.add("hidden");
  restartDaemon();
});

// ============================================================
// Popover helpers
// ============================================================
function positionPopover(el, anchorEl, opts = {}) {
  el.style.visibility = "hidden";
  el.classList.remove("hidden");
  const w = el.offsetWidth || 220;
  el.classList.add("hidden");
  el.style.visibility = "";

  const rect = anchorEl.getBoundingClientRect();
  el.style.top = `${window.scrollY + rect.bottom + 6}px`;
  let left;
  if (opts.align === "right") {
    left = rect.right - w;
  } else {
    left = rect.left;
  }
  left = Math.max(8, Math.min(window.innerWidth - w - 8, left));
  el.style.left = `${left}px`;
}

function closeAllPopovers() {
  closePicker();
  closeRowMenu();
  overflow.classList.add("hidden");
  helpMenu.classList.add("hidden");
}
document.addEventListener("click", (e) => {
  if (picker.contains(e.target) || rowmenu.contains(e.target) ||
      overflow.contains(e.target) || helpMenu.contains(e.target)) return;
  if (e.target.closest(".wrow")) return;
  closeAllPopovers();
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeAllPopovers(); });

// ============================================================
// Labels modal
// ============================================================
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
      <button title="Delete" data-id="${lb.id}">×</button>
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

// ============================================================
// Add time modal
// ============================================================
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
  const d = new Date();
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
  const when = addWhen.value ? new Date(addWhen.value) : new Date();
  const when_ts = (when.getTime() / 1000) - seconds;
  const r = await api("POST", "/api/manual", { app, domain, seconds, when_ts });
  if (r.error) return alert("Error: " + r.error);
  addModal.classList.add("hidden");
  load();
});

// ============================================================
// CSV import
// ============================================================
const importModal = document.getElementById("import-modal");
const importFile = document.getElementById("import-file");
const importFilename = document.getElementById("import-filename");
const importAnchor = document.getElementById("import-anchor");
const importLabel = document.getElementById("import-label");
const importPreview = document.getElementById("import-preview");
const importGo = document.getElementById("import-go");
let importParsed = null;

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
  if (h.includes("date") && h.includes("productivity level") && h.includes("app/url name")) return "desktime";
  if (h.includes("project") && (h.includes("time (decimal)") || h.includes("time (h)"))) return "clockify";
  return null;
}

const DESKTIME_LABEL = { productive: "verimli", neutral: "genel", unproductive: "verimsiz" };
const DESKTIME_SKIP_NAMES = new Set([
  "google chrome", "google-chrome-stable", "msedge", "microsoft edge",
  "firefox", "firefox_firefox", "safari", "unknown app",
]);

function classifyDeskTimeName(name) {
  if (/^(chrome:|chrome-extension:|about:)/i.test(name)) return { app: "chrome", domain: null };
  if (name.startsWith("///") || name.startsWith("/")) return { app: "file", domain: null };
  const host = name.split(/[\/?#]/)[0];
  if (/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) {
    const normalized = host.startsWith("www.") ? host.slice(4) : host;
    return { app: "chrome", domain: normalized };
  }
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
    importGo.disabled = true; importParsed = null; return;
  }
  const format = detectFormat(rows[0]);
  if (!format) {
    importPreview.textContent =
      "Unrecognized CSV. Supported formats:\n" +
      "  • Clockify Summary (columns: Project, Description, Time (decimal))\n" +
      "  • DeskTime Export  (columns: Date, App/URL name, Productivity level, Time)";
    importGo.disabled = true; importParsed = null; return;
  }
  importParsed = format === "desktime" ? parseDeskTime(rows) : parseClockify(rows);
  const anchorWrap = document.getElementById("import-anchor-wrap");
  if (anchorWrap) anchorWrap.style.display = format === "desktime" ? "none" : "";
  if (format === "desktime") {
    importLabel.value = "";
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
  importAnchor.value = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T23:59`;
  importLabel.value = "verimli";
  importLabel.placeholder = "e.g. verimli (blank = none)";
  const anchorWrap = document.getElementById("import-anchor-wrap");
  if (anchorWrap) anchorWrap.style.display = "";
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
  let events; let titleTag;
  if (importParsed.usesRowDates) {
    events = importParsed.events.map(ev => ({
      app: ev.app, domain: ev.domain || null, title: ev.title || null,
      seconds: ev.seconds, when_ts: ev.when_ts,
      label: overrideLabel ? null : (ev.label || null),
    }));
    titleTag = "[desktime]";
  } else {
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
  if (r.error) { importGo.disabled = false; return alert("Import failed: " + r.error); }
  importModal.classList.add("hidden");
  await refreshLabels();
  await load();
  const labelPart = r.labeled_targets ? ` Created ${r.labeled_targets} label rule(s).` : "";
  alert(`Imported ${r.inserted} events.${labelPart}`);
});

// ============================================================
// Settings modal
// ============================================================
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

// ============================================================
// Restart daemon
// ============================================================
async function restartDaemon() {
  if (!confirm("Restart the Omrum daemon? In-progress spans are flushed; tracking resumes in a second.")) return;
  try { await api("POST", "/api/restart"); } catch (_) { /* server going away */ }
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const r = await fetch("/api/health", { cache: "no-store" });
      if (r.ok) { location.href = "/?r=" + Date.now(); return; }
    } catch (_) { /* still down */ }
  }
  alert("Daemon didn't come back within 20s — check journalctl or /tmp/omrum-runtime.log.");
}

// ============================================================
// Min-duration filter
// ============================================================
const minDurInput = document.getElementById("min-dur");
const savedMin = localStorage.getItem("omrum_min_dur_min");
if (savedMin !== null) minDurInput.value = savedMin;
let minDurTimer = null;
minDurInput.addEventListener("input", () => {
  const v = Math.max(0, parseFloat(minDurInput.value) || 0);
  localStorage.setItem("omrum_min_dur_min", String(v));
  clearTimeout(minDurTimer);
  minDurTimer = setTimeout(() => {
    state.othersExpanded = {};
    if (state.lastData) renderGrouped(state.lastData.activity || []);
  }, 120);
});

// ============================================================
// Keyboard shortcuts
// ============================================================
document.addEventListener("keydown", (e) => {
  // ignore when typing in form fields, modals are open, or meta keys pressed
  const tag = (e.target && e.target.tagName) || "";
  if (/INPUT|TEXTAREA|SELECT/.test(tag)) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const anyModalOpen = Array.from(document.querySelectorAll(".modal")).some((m) => !m.classList.contains("hidden"));
  if (anyModalOpen) return;

  const k = e.key.toLowerCase();
  if (k === "t") { document.getElementById("today").click(); }
  else if (e.key === "ArrowLeft")  { document.getElementById("prev").click(); }
  else if (e.key === "ArrowRight") { document.getElementById("next").click(); }
  else if (k === "d") { setPeriod("day"); }
  else if (k === "w") { setPeriod("week"); }
  else if (k === "m") { setPeriod("month"); }
  else if (k === "y") { setPeriod("year"); }
  else if (k === "r") { setPeriod("range"); }
  else if (k === "a") { openAddTime(); }
  else if (k === "i") { openImport(); }
  else if (e.key === "?" || (e.shiftKey && k === "/")) {
    const btn = document.getElementById("help-keys");
    if (helpMenu.classList.contains("hidden")) openHelp(btn);
    else helpMenu.classList.add("hidden");
  }
});

// ============================================================
// Candle (timeline bucket size) control
// ============================================================
const candleInput = document.getElementById("candle-min");
const candleReset = document.getElementById("candle-reset");

function persistBucketMin() {
  try { localStorage.setItem("omrum_bucket_min", JSON.stringify(state.bucketMin)); }
  catch (_) { /* quota / disabled — fine */ }
}

function syncCandleInput(timeline) {
  if (!timeline) return;
  const bounds = timeline.bucket_min_bounds || { min: 1, max: 1440, default_min: 60 };
  candleInput.min = String(bounds.min);
  candleInput.max = String(bounds.max);
  // Don't overwrite an actively-edited input on periodic auto-reloads.
  if (document.activeElement === candleInput) return;
  const override = state.bucketMin[state.period];
  if (override != null) {
    // Clamp a stale override against the active window's bounds.
    const clamped = Math.max(bounds.min, Math.min(bounds.max, override));
    if (clamped !== override) {
      state.bucketMin[state.period] = clamped;
      persistBucketMin();
    }
    candleInput.value = String(clamped);
    candleInput.placeholder = `${bounds.default_min} (auto)`;
  } else {
    candleInput.value = "";
    const effective = Math.round((timeline.bucket_s || bounds.default_min * 60) / 60);
    candleInput.placeholder = `${effective} (auto)`;
  }
}

let candleTimer = null;
candleInput.addEventListener("input", () => {
  clearTimeout(candleTimer);
  candleTimer = setTimeout(() => {
    const v = candleInput.value.trim();
    if (v === "") {
      if (state.bucketMin[state.period] != null) {
        delete state.bucketMin[state.period];
        persistBucketMin();
        load();
      }
      return;
    }
    const n = parseFloat(v);
    if (!isFinite(n) || n <= 0) return;
    const min = parseFloat(candleInput.min) || 1;
    const max = parseFloat(candleInput.max) || 1440;
    const clamped = Math.max(min, Math.min(max, n));
    state.bucketMin[state.period] = clamped;
    persistBucketMin();
    load();
  }, 300);
});

candleReset.addEventListener("click", () => {
  if (state.bucketMin[state.period] == null) return;
  delete state.bucketMin[state.period];
  persistBucketMin();
  load();
});

// ============================================================
// Init
// ============================================================
(async () => {
  await refreshLabels();
  await load();
  requestAnimationFrame(movePill);
  setInterval(load, 15000);
})();
