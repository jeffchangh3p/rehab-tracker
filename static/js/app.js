"use strict";

/* =========================================================================
   復健紀錄手冊 — 前端
   ========================================================================= */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const state = {
  view: "today",
  today: localDateStr(),
  profile: {},
  chartRange: 7,
  editingRehab: null,   // 目前編輯中的復健紀錄 id
  editingVitals: null,
  modalPhoto: null,     // data URI 或 null
  modalVoice: null,     // data URI 或 null
};

/* ----------------------------- 工具 ----------------------------- */
function pad(n) { return String(n).padStart(2, "0"); }
function localDateStr(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function localTimeStr(d = new Date()) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function parseDate(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function shiftDate(s, days) {
  const d = parseDate(s);
  d.setDate(d.getDate() + days);
  return localDateStr(d);
}
function fmtDateHuman(s) {
  const d = parseDate(s);
  const wk = "日一二三四五六"[d.getDay()];
  return `${d.getMonth() + 1}月${d.getDate()}日（週${wk}）`;
}
function fmtNum(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!isFinite(n)) return null;
  return Number.isInteger(n) ? String(n) : String(n);
}
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 2200);
}

/* ----------------------------- API ----------------------------- */
async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  if (res.status === 401) { location.href = "/login"; throw new Error("unauthorized"); }
  const ct = res.headers.get("content-type") || "";
  const data = ct.includes("application/json") ? await res.json() : await res.text();
  if (!res.ok) throw new Error((data && data.error) || "發生錯誤");
  return data;
}
const API = {
  profile: () => api("GET", "/api/profile"),
  saveProfile: (p) => api("PUT", "/api/profile", p),
  summary: (date) => api("GET", `/api/summary?date=${date}`),
  rehab: (date) => api("GET", "/api/rehab" + (date ? `?date=${date}` : "")),
  createRehab: (b) => api("POST", "/api/rehab", b),
  updateRehab: (id, b) => api("PUT", `/api/rehab/${id}`, b),
  deleteRehab: (id) => api("DELETE", `/api/rehab/${id}`),
  vitals: (date) => api("GET", "/api/vitals" + (date ? `?date=${date}` : "")),
  createVitals: (b) => api("POST", "/api/vitals", b),
  updateVitals: (id, b) => api("PUT", `/api/vitals/${id}`, b),
  deleteVitals: (id) => api("DELETE", `/api/vitals/${id}`),
  restore: (b) => api("POST", "/api/restore", b),
};

/* ----------------------------- 導覽 ----------------------------- */
function switchTab(name) {
  state.view = name;
  $$(".view").forEach((v) => { v.hidden = v.dataset.view !== name; });
  $$("#tabbar button").forEach((b) => b.classList.toggle("is-active", b.dataset.tab === name));
  window.scrollTo(0, 0);
  if (name === "today") renderToday();
  else if (name === "rehab") renderRehabList();
  else if (name === "vitals") renderVitalsList();
  else if (name === "charts") renderCharts();
  else if (name === "settings") loadSettings();
}

/* ----------------------------- 今日 ----------------------------- */
const CHEERS = [
  "今天有做，就是勝利。",
  "每天一點點，慢慢會更好。",
  "做多做少都沒關係，有做就是進步！",
  "爸爸加油，全家陪你一起 💪",
  "每做完一次，就給自己一個大大的讚！",
];

async function renderToday() {
  $("#todayDate").value = state.today;
  $("#cheer").textContent = CHEERS[parseDate(state.today).getDate() % CHEERS.length];

  let summary, rehab, vitals;
  try {
    [summary, rehab, vitals] = await Promise.all([
      API.summary(state.today), API.rehab(state.today), API.vitals(state.today),
    ]);
  } catch (e) { toast(e.message); return; }

  renderGoals(summary);
  renderTimeline(rehab, vitals);
}

function goalCard(emoji, name, done, goal, unit) {
  const hasGoal = goal && goal > 0;
  const pct = hasGoal ? Math.min(100, Math.round((done / goal) * 100)) : 0;
  const isDone = hasGoal && done >= goal;
  return `
    <div class="goal-card ${isDone ? "is-done" : ""} ${hasGoal ? "" : "no-goal"}">
      <div class="goal-card__top">
        <div class="goal-card__name"><span class="emoji">${emoji}</span>${name}
          ${isDone ? '<span class="goal-card__done-tag">達標 🎉</span>' : ""}</div>
        <div class="goal-card__val">
          <b>${fmtNum(done) ?? 0}</b>${hasGoal ? `<span class="goal"> / ${fmtNum(goal)}</span>` : ""}<span class="unit">${unit}</span>
        </div>
      </div>
      ${hasGoal
        ? `<div class="bar"><div class="bar__fill" style="width:${pct}%"></div></div>`
        : `<div class="goal-card__hint">尚未設定目標（可到「設定」填寫）</div>`}
    </div>`;
}

function renderGoals(s) {
  $("#goals").innerHTML =
    goalCard("🦵", "抬腿", s.leg_raise.done, s.leg_raise.goal, "下") +
    goalCard("🧍", "站立", s.standing.done, s.standing.goal, "下") +
    goalCard("🚶", "行走", s.walking.done, s.walking.goal, "圈");
}

function renderTimeline(rehab, vitals) {
  const items = [
    ...rehab.map((r) => ({ kind: "rehab", ...r })),
    ...vitals.map((v) => ({ kind: "vitals", ...v })),
  ].sort((a, b) => (b.time || "").localeCompare(a.time || "") || b.id - a.id);

  const el = $("#todayTimeline");
  if (!items.length) {
    el.innerHTML = `<div class="empty">今天還沒有紀錄，<br>點上面的按鈕新增第一筆吧！</div>`;
    return;
  }
  el.innerHTML = items.map(recCard).join("");
}

/* ----------------------------- 紀錄卡 ----------------------------- */
function recCard(r) {
  if (r.kind === "rehab") return rehabCard(r);
  return vitalsCard(r);
}

function rehabCard(r) {
  const chips = [];
  if (fmtNum(r.leg_raise) !== null) chips.push(`<span class="chip">🦵 抬腿 ${fmtNum(r.leg_raise)}</span>`);
  if (fmtNum(r.standing) !== null) chips.push(`<span class="chip">🧍 站立 ${fmtNum(r.standing)}</span>`);
  if (fmtNum(r.walking) !== null) chips.push(`<span class="chip">🚶 行走 ${fmtNum(r.walking)} 圈</span>`);
  if (!chips.length) chips.push(`<span class="chip">復健</span>`);
  const media = [];
  if (r.photo) media.push(`<img src="${esc(r.photo)}" alt="照片">`);
  if (r.voice) media.push(`<audio controls src="${esc(r.voice)}"></audio>`);
  return `
    <div class="rec" data-edit-rehab="${r.id}">
      <div class="rec__icon">🦵</div>
      <div class="rec__body">
        <div class="rec__time">${esc(r.time || "")}</div>
        <div class="rec__metrics">${chips.join("")}</div>
        ${r.notes ? `<div class="rec__notes">${esc(r.notes)}</div>` : ""}
        ${media.length ? `<div class="rec__media">${media.join("")}</div>` : ""}
      </div>
    </div>`;
}

function bpClass(sys, dia) {
  if (sys == null && dia == null) return "";
  if ((sys && sys >= 140) || (dia && dia >= 90)) return " · 偏高";
  if ((sys && sys < 90) || (dia && dia < 60)) return " · 偏低";
  return "";
}

function vitalsCard(v) {
  const chips = [];
  if (v.systolic != null || v.diastolic != null) {
    const s = v.systolic != null ? v.systolic : "—";
    const d = v.diastolic != null ? v.diastolic : "—";
    chips.push(`<span class="chip chip--bp">🩸 血壓 ${s}/${d}${bpClass(v.systolic, v.diastolic)}</span>`);
  }
  if (v.pulse != null) chips.push(`<span class="chip chip--bp">💓 脈搏 ${v.pulse}</span>`);
  if (v.blood_sugar != null) {
    chips.push(`<span class="chip chip--orange">🍬 血糖 ${fmtNum(v.blood_sugar)}${v.sugar_context ? " " + esc(v.sugar_context) : ""}</span>`);
  }
  if (!chips.length) chips.push(`<span class="chip chip--bp">血壓血糖</span>`);
  return `
    <div class="rec" data-edit-vitals="${v.id}">
      <div class="rec__icon">❤️</div>
      <div class="rec__body">
        <div class="rec__time">${esc(v.time || "")}</div>
        <div class="rec__metrics">${chips.join("")}</div>
        ${v.notes ? `<div class="rec__notes">${esc(v.notes)}</div>` : ""}
      </div>
    </div>`;
}

/* ----------------------------- 清單（依日期分組） ----------------------------- */
function groupByDate(rows) {
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.date)) map.set(r.date, []);
    map.get(r.date).push(r);
  }
  return [...map.entries()]; // 已由後端依日期新到舊排序
}

async function renderRehabList() {
  let rows;
  try { rows = await API.rehab(); } catch (e) { toast(e.message); return; }
  const el = $("#rehabList");
  if (!rows.length) { el.innerHTML = `<div class="empty">還沒有復健紀錄，點「＋ 新增」開始吧！</div>`; return; }
  el.innerHTML = groupByDate(rows).map(([date, items]) => `
    <div class="rec-group">
      <div class="rec-group__date">${fmtDateHuman(date)}</div>
      ${items.map(rehabCard).join("")}
    </div>`).join("");
}

async function renderVitalsList() {
  let rows;
  try { rows = await API.vitals(); } catch (e) { toast(e.message); return; }
  const el = $("#vitalsList");
  if (!rows.length) { el.innerHTML = `<div class="empty">還沒有血壓血糖紀錄，點「＋ 新增」開始吧！</div>`; return; }
  el.innerHTML = groupByDate(rows).map(([date, items]) => `
    <div class="rec-group">
      <div class="rec-group__date">${fmtDateHuman(date)}</div>
      ${items.map(vitalsCard).join("")}
    </div>`).join("");
}

/* ----------------------------- 圖表 ----------------------------- */
function dateRangeList(startStr, endStr) {
  const out = [];
  let cur = parseDate(startStr);
  const end = parseDate(endStr);
  let guard = 0;
  while (cur <= end && guard++ < 2000) {
    out.push(localDateStr(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

function niceMax(v) {
  if (v <= 0) return 1;
  // 含小數值的刻度（行走圈數常是 1~3），否則 y 軸永遠從 10 起跳，長條會擠成看不出差異。
  const steps = [1, 2, 3, 4, 5, 6, 8, 10, 15, 20, 30, 40, 50, 60, 80, 100, 120, 140, 160, 200, 250, 300, 400, 500];
  const target = v * 1.15;
  for (const s of steps) if (s >= target) return s;
  return Math.ceil(target / 100) * 100;
}

function shortLabel(s) { const d = parseDate(s); return `${d.getMonth() + 1}/${d.getDate()}`; }

/*
 * buildChart：以純 SVG 繪製長條圖或折線圖。
 *   type: 'bar' | 'line'
 *   labels: [dateStr]
 *   series: [{ name, color, values:[num|null] }]
 */
function buildChart({ type, labels, series }) {
  const W = 340, H = 190;
  const mL = 30, mR = 10, mT = 12, mB = 26;
  const plotW = W - mL - mR, plotH = H - mT - mB;
  const n = labels.length;

  let maxV = 0, minV = Infinity;
  for (const s of series) for (const v of s.values) {
    if (v == null) continue;
    if (v > maxV) maxV = v;
    if (v < minV) minV = v;
  }
  // 長條圖從 0 起算；折線（血壓 / 血糖）用資料的 [min,max] 加緩衝，才看得出變化。
  let yMin, yMax;
  if (type === "line") {
    if (minV === Infinity) { minV = 0; maxV = 1; }
    const span = (maxV - minV) || Math.max(1, maxV * 0.1);
    const pad = span * 0.15;
    yMin = Math.max(0, Math.floor(minV - pad));
    yMax = Math.ceil(maxV + pad);
    if (yMax <= yMin) yMax = yMin + 1;
  } else {
    yMin = 0;
    yMax = niceMax(maxV);
  }

  const x0 = mL, y0 = mT + plotH;
  const span = yMax - yMin || 1;
  const yOf = (v) => y0 - ((v - yMin) / span) * plotH;
  const band = n > 0 ? plotW / n : plotW;
  const xCenter = (i) => x0 + band * (i + 0.5);

  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img">`;

  // 水平格線 + Y 軸標籤
  for (let g = 0; g <= 2; g++) {
    const val = yMin + (span / 2) * g;
    const y = yOf(val);
    svg += `<line x1="${x0}" y1="${y}" x2="${W - mR}" y2="${y}" stroke="#eef3f1" stroke-width="1"/>`;
    svg += `<text x="${x0 - 4}" y="${y + 3}" font-size="8" fill="#9aa8a3" text-anchor="end">${Math.round(val)}</text>`;
  }

  if (type === "bar") {
    const gw = band * 0.7;
    const bw = series.length ? gw / series.length : gw;
    labels.forEach((_, i) => {
      series.forEach((s, si) => {
        const v = s.values[i];
        if (v == null || v <= 0) return;
        const bx = xCenter(i) - gw / 2 + si * bw;
        const by = yOf(v);
        const bh = y0 - by;
        svg += `<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${(bw - 1).toFixed(1)}" height="${bh.toFixed(1)}" rx="2" fill="${s.color}"/>`;
      });
    });
  } else {
    series.forEach((s) => {
      let dPath = "", started = false;
      labels.forEach((_, i) => {
        const v = s.values[i];
        if (v == null) { started = false; return; }
        const x = xCenter(i), y = yOf(v);
        dPath += (started ? "L" : "M") + x.toFixed(1) + " " + y.toFixed(1) + " ";
        started = true;
      });
      if (dPath) svg += `<path d="${dPath}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
      labels.forEach((_, i) => {
        const v = s.values[i];
        if (v == null) return;
        svg += `<circle cx="${xCenter(i).toFixed(1)}" cy="${yOf(v).toFixed(1)}" r="2.4" fill="${s.color}"/>`;
      });
    });
  }

  // X 軸標籤（最多約 6 個）
  const step = Math.max(1, Math.ceil(n / 6));
  labels.forEach((lb, i) => {
    if (i % step !== 0 && i !== n - 1) return;
    svg += `<text x="${xCenter(i).toFixed(1)}" y="${H - 8}" font-size="8" fill="#9aa8a3" text-anchor="middle">${shortLabel(lb)}</text>`;
  });

  svg += `</svg>`;

  const legend = series.length > 1
    ? `<div class="chart-legend">${series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join("")}</div>`
    : "";
  return svg + legend;
}

function chartCard(title, sub, inner) {
  return `<div class="chart-card"><h3>${esc(title)}</h3><div class="chart-sub">${esc(sub)}</div>${inner}</div>`;
}

async function renderCharts() {
  $$("#rangeTabs button").forEach((b) => b.classList.toggle("is-active", Number(b.dataset.range) === state.chartRange));
  const wrap = $("#chartsWrap");
  wrap.innerHTML = `<div class="empty">載入中…</div>`;

  let rehab, vitals;
  try { [rehab, vitals] = await Promise.all([API.rehab(), API.vitals()]); }
  catch (e) { toast(e.message); return; }

  if (!rehab.length && !vitals.length) {
    wrap.innerHTML = `<div class="empty">還沒有資料，開始紀錄後就會看到進步曲線 📈</div>`;
    return;
  }

  // 決定日期範圍
  const today = localDateStr();
  let startStr;
  if (state.chartRange === 0) {
    const dates = [...rehab, ...vitals].map((r) => r.date).filter(Boolean).sort();
    startStr = dates.length ? dates[0] : today;
  } else {
    startStr = shiftDate(today, -(state.chartRange - 1));
  }
  const labels = dateRangeList(startStr, today);
  const idx = new Map(labels.map((d, i) => [d, i]));
  const blank = () => labels.map(() => null);

  // 復健：每日加總
  const leg = blank(), stand = blank(), walk = blank();
  for (const r of rehab) {
    const i = idx.get(r.date); if (i === undefined) continue;
    if (r.leg_raise != null) leg[i] = (leg[i] || 0) + Number(r.leg_raise);
    if (r.standing != null) stand[i] = (stand[i] || 0) + Number(r.standing);
    if (r.walking != null) walk[i] = (walk[i] || 0) + Number(r.walking);
  }
  // 血壓 / 血糖：取當日最後一筆（時間最大）
  const sys = blank(), dia = blank(), sugar = blank();
  const seen = {};
  for (const v of [...vitals].sort((a, b) => (a.time || "").localeCompare(b.time || ""))) {
    const i = idx.get(v.date); if (i === undefined) continue;
    if (v.systolic != null) sys[i] = v.systolic;
    if (v.diastolic != null) dia[i] = v.diastolic;
    if (v.blood_sugar != null) sugar[i] = Number(v.blood_sugar);
  }

  const has = (arr) => arr.some((v) => v != null);
  let html = "";

  if (has(leg) || has(stand)) {
    html += chartCard("抬腿 / 站立（每日總次數）", "越高越好，慢慢往上加油 💪",
      buildChart({ type: "bar", labels, series: [
        { name: "抬腿", color: "#2f6d5f", values: leg },
        { name: "站立", color: "#7cbcae", values: stand },
      ]}));
  }
  if (has(walk)) {
    html += chartCard("行走（每日圈數）", "每天多走一點點",
      buildChart({ type: "bar", labels, series: [{ name: "行走", color: "#e0912f", values: walk }] }));
  }
  if (has(sys) || has(dia)) {
    html += chartCard("血壓趨勢", "收縮壓（高）／舒張壓（低）",
      buildChart({ type: "line", labels, series: [
        { name: "收縮壓", color: "#c0483b", values: sys },
        { name: "舒張壓", color: "#e0912f", values: dia },
      ]}));
  }
  if (has(sugar)) {
    html += chartCard("血糖趨勢", "mg/dL",
      buildChart({ type: "line", labels, series: [{ name: "血糖", color: "#8a5cc4", values: sugar }] }));
  }
  wrap.innerHTML = html || `<div class="empty">這個時間範圍內沒有資料，換個範圍看看。</div>`;
}

/* ----------------------------- 設定 ----------------------------- */
async function loadSettings() {
  let p;
  try { p = await API.profile(); } catch (e) { toast(e.message); return; }
  state.profile = p;
  $("#pName").value = p.name || "";
  $("#pStart").value = p.start_date || "";
  $("#gLegReps").value = p.goal_leg_raise_reps || "";
  $("#gLegTimes").value = p.goal_leg_raise_times || "";
  $("#gStandReps").value = p.goal_standing_reps || "";
  $("#gStandTimes").value = p.goal_standing_times || "";
  $("#gWalkLaps").value = p.goal_walking_laps || "";
}

async function saveProfile() {
  const body = {
    name: $("#pName").value.trim(),
    start_date: $("#pStart").value,
    goal_leg_raise_reps: $("#gLegReps").value,
    goal_leg_raise_times: $("#gLegTimes").value,
    goal_standing_reps: $("#gStandReps").value,
    goal_standing_times: $("#gStandTimes").value,
    goal_walking_laps: $("#gWalkLaps").value,
  };
  try {
    state.profile = await API.saveProfile(body);
    updateHeaderName();
    const h = $("#profileSaved"); h.hidden = false; setTimeout(() => (h.hidden = true), 1800);
    toast("已儲存 ✔");
  } catch (e) { toast(e.message); }
}

function updateHeaderName() {
  const n = state.profile && state.profile.name;
  $("#headerName").textContent = n ? `${n} · 加油！` : "";
}

/* ----------------------------- 復健表單 ----------------------------- */
function openModal(id) { $("#" + id).hidden = false; document.body.style.overflow = "hidden"; }
function closeModal(id) {
  $("#" + id).hidden = true;
  document.body.style.overflow = "";
  if (id === "rehabModal") discardVoiceRecording();  // 關閉表單一定要關掉麥克風
}

function openRehabModal(entry) {
  discardVoiceRecording();  // 清掉上一次可能還在進行的錄音
  state.editingRehab = entry ? entry.id : null;
  state.modalPhoto = entry ? (entry.photo || null) : null;
  state.modalVoice = entry ? (entry.voice || null) : null;
  $("#rehabModalTitle").textContent = entry ? "編輯復健紀錄" : "新增復健紀錄";
  $("#rehabId").value = entry ? entry.id : "";
  $("#rDate").value = entry ? entry.date : state.today;
  $("#rTime").value = entry ? (entry.time || "") : localTimeStr();
  $("#rLeg").value = entry && entry.leg_raise != null ? entry.leg_raise : "";
  $("#rStand").value = entry && entry.standing != null ? entry.standing : "";
  $("#rWalk").value = entry && entry.walking != null ? entry.walking : "";
  $("#rNotes").value = entry ? (entry.notes || "") : "";
  $("#rPhoto").value = "";
  $("#rehabDelete").hidden = !entry;
  renderMediaPreview();
  openModal("rehabModal");
}

async function saveRehab() {
  const body = {
    date: $("#rDate").value || state.today,
    time: $("#rTime").value,
    leg_raise: $("#rLeg").value,
    standing: $("#rStand").value,
    walking: $("#rWalk").value,
    notes: $("#rNotes").value.trim(),
    photo: state.modalPhoto,
    voice: state.modalVoice,
  };
  try {
    if (state.editingRehab) await API.updateRehab(state.editingRehab, body);
    else await API.createRehab(body);
    closeModal("rehabModal");
    toast("已儲存 ✔");
    refreshCurrent();
  } catch (e) { toast(e.message); }
}

async function deleteRehab() {
  if (!state.editingRehab) return;
  if (!confirm("確定要刪除這筆復健紀錄嗎？")) return;
  try {
    await API.deleteRehab(state.editingRehab);
    closeModal("rehabModal");
    toast("已刪除");
    refreshCurrent();
  } catch (e) { toast(e.message); }
}

/* ----------------------------- 血壓血糖表單 ----------------------------- */
function openVitalsModal(entry) {
  state.editingVitals = entry ? entry.id : null;
  $("#vitalsModalTitle").textContent = entry ? "編輯血壓血糖" : "新增血壓血糖";
  $("#vitalsId").value = entry ? entry.id : "";
  $("#vDate").value = entry ? entry.date : state.today;
  $("#vTime").value = entry ? (entry.time || "") : localTimeStr();
  $("#vSys").value = entry && entry.systolic != null ? entry.systolic : "";
  $("#vDia").value = entry && entry.diastolic != null ? entry.diastolic : "";
  $("#vPulse").value = entry && entry.pulse != null ? entry.pulse : "";
  $("#vSugar").value = entry && entry.blood_sugar != null ? entry.blood_sugar : "";
  $("#vContext").value = entry ? (entry.sugar_context || "") : "";
  $("#vNotes").value = entry ? (entry.notes || "") : "";
  $("#vitalsDelete").hidden = !entry;
  openModal("vitalsModal");
}

async function saveVitals() {
  const body = {
    date: $("#vDate").value || state.today,
    time: $("#vTime").value,
    systolic: $("#vSys").value,
    diastolic: $("#vDia").value,
    pulse: $("#vPulse").value,
    blood_sugar: $("#vSugar").value,
    sugar_context: $("#vContext").value,
    notes: $("#vNotes").value.trim(),
  };
  try {
    if (state.editingVitals) await API.updateVitals(state.editingVitals, body);
    else await API.createVitals(body);
    closeModal("vitalsModal");
    toast("已儲存 ✔");
    refreshCurrent();
  } catch (e) { toast(e.message); }
}

async function deleteVitals() {
  if (!state.editingVitals) return;
  if (!confirm("確定要刪除這筆血壓血糖紀錄嗎？")) return;
  try {
    await API.deleteVitals(state.editingVitals);
    closeModal("vitalsModal");
    toast("已刪除");
    refreshCurrent();
  } catch (e) { toast(e.message); }
}

function refreshCurrent() {
  if (state.view === "today") renderToday();
  else if (state.view === "rehab") renderRehabList();
  else if (state.view === "vitals") renderVitalsList();
  else if (state.view === "charts") renderCharts();
}

/* ----------------------------- 媒體：照片 / 語音 ----------------------------- */
function resizeImage(file, maxDim = 1000, quality = 0.7) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          if (width >= height) { height = Math.round(height * maxDim / width); width = maxDim; }
          else { width = Math.round(width * maxDim / height); height = maxDim; }
        }
        const canvas = document.createElement("canvas");
        canvas.width = width; canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function renderMediaPreview() {
  const el = $("#rMediaPreview");
  let html = "";
  if (state.modalPhoto) {
    html += `<div class="thumb-wrap"><img src="${esc(state.modalPhoto)}" alt="照片預覽">
             <button type="button" class="remove-media" data-remove="photo">✕</button></div>`;
  }
  if (state.modalVoice) {
    html += `<div class="rowline"><audio controls src="${esc(state.modalVoice)}"></audio>
             <button type="button" class="remove-media" style="position:static" data-remove="voice">✕</button></div>`;
  }
  el.innerHTML = html;
}

/* 語音錄製 */
let mediaRecorder = null, audioChunks = [], voiceStream = null, voiceTimer = null;
const VOICE_MAX_MS = 120000; // 最長 2 分鐘，避免備份檔過大

function stopVoiceTracks() {
  if (voiceStream) { voiceStream.getTracks().forEach((t) => t.stop()); voiceStream = null; }
}
function resetVoiceUI() {
  const btn = document.getElementById("rVoiceBtn");
  if (btn) { btn.classList.remove("is-recording"); btn.textContent = "🎤 錄語音"; }
}
// 切換 / 關閉表單時丟棄進行中的錄音：關掉麥克風、重設按鈕，
// 避免麥克風一直開著，也避免上一段錄音跑進下一筆新紀錄。
function discardVoiceRecording() {
  if (voiceTimer) { clearTimeout(voiceTimer); voiceTimer = null; }
  if (mediaRecorder && mediaRecorder.state === "recording") {
    try { mediaRecorder.ondataavailable = null; mediaRecorder.onstop = null; mediaRecorder.stop(); } catch (_) {}
  }
  mediaRecorder = null;
  audioChunks = [];
  stopVoiceTracks();
  resetVoiceUI();
}

async function toggleVoice() {
  const btn = $("#rVoiceBtn");
  if (mediaRecorder && mediaRecorder.state === "recording") { mediaRecorder.stop(); return; }
  if (!navigator.mediaDevices || !window.MediaRecorder) { toast("這個瀏覽器不支援錄音"); return; }
  try {
    voiceStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];
    const rec = new MediaRecorder(voiceStream);
    mediaRecorder = rec;
    rec.ondataavailable = (e) => { if (e.data.size) audioChunks.push(e.data); };
    rec.onstop = () => {
      if (voiceTimer) { clearTimeout(voiceTimer); voiceTimer = null; }
      stopVoiceTracks();
      resetVoiceUI();
      mediaRecorder = null;
      const blob = new Blob(audioChunks, { type: rec.mimeType || "audio/webm" });
      const reader = new FileReader();
      reader.onload = () => { state.modalVoice = reader.result; renderMediaPreview(); };
      reader.readAsDataURL(blob);
    };
    rec.start();
    voiceTimer = setTimeout(() => {
      if (mediaRecorder && mediaRecorder.state === "recording") { toast("錄音已達 2 分鐘上限"); mediaRecorder.stop(); }
    }, VOICE_MAX_MS);
    btn.classList.add("is-recording");
    btn.textContent = "⏹ 停止錄音";
  } catch (e) {
    stopVoiceTracks();
    toast("無法使用麥克風");
  }
}

/* ----------------------------- 備份 / 還原 ----------------------------- */
function doRestore(file) {
  const reader = new FileReader();
  reader.onload = async () => {
    let data;
    try { data = JSON.parse(reader.result); }
    catch { toast("檔案不是有效的 JSON"); return; }
    if (!confirm("還原會【覆蓋】目前所有資料，確定要繼續嗎？\n建議先下載一次目前的備份。")) return;
    try {
      await API.restore(data);
      toast("已還原 ✔");
      await bootProfile();
      switchTab("today");
    } catch (e) { toast(e.message); }
  };
  reader.readAsText(file);
}

/* ----------------------------- 初始化 ----------------------------- */
async function bootProfile() {
  try { state.profile = await API.profile(); updateHeaderName(); } catch (_) {}
}

function bindEvents() {
  // 分頁
  $$("#tabbar button").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));

  // 今日日期
  $("#todayDate").addEventListener("change", (e) => { state.today = e.target.value; renderToday(); });
  $("#todayPrev").addEventListener("click", () => { state.today = shiftDate(state.today, -1); renderToday(); });
  $("#todayNext").addEventListener("click", () => { state.today = shiftDate(state.today, 1); renderToday(); });
  $("#todayNow").addEventListener("click", () => { state.today = localDateStr(); renderToday(); });

  // 快速新增
  $$("[data-add]").forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.add === "rehab") openRehabModal(null);
    else openVitalsModal(null);
  }));

  // 點擊紀錄卡 → 編輯
  document.addEventListener("click", async (e) => {
    const rc = e.target.closest("[data-edit-rehab]");
    if (rc) {
      try {
        const all = await API.rehab();
        const entry = all.find((x) => x.id === Number(rc.dataset.editRehab));
        if (entry) openRehabModal(entry);
      } catch (err) { toast(err.message); }
      return;
    }
    const vc = e.target.closest("[data-edit-vitals]");
    if (vc) {
      try {
        const all = await API.vitals();
        const entry = all.find((x) => x.id === Number(vc.dataset.editVitals));
        if (entry) openVitalsModal(entry);
      } catch (err) { toast(err.message); }
    }
  });

  // 彈窗關閉
  $$("[data-close]").forEach((b) => b.addEventListener("click", () => {
    closeModal("rehabModal"); closeModal("vitalsModal");
  }));

  // 儲存 / 刪除
  $("#rehabSave").addEventListener("click", saveRehab);
  $("#rehabDelete").addEventListener("click", deleteRehab);
  $("#vitalsSave").addEventListener("click", saveVitals);
  $("#vitalsDelete").addEventListener("click", deleteVitals);

  // 媒體
  $("#rPhoto").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try { state.modalPhoto = await resizeImage(file); renderMediaPreview(); }
    catch { toast("照片讀取失敗"); }
  });
  $("#rVoiceBtn").addEventListener("click", toggleVoice);
  $("#rMediaPreview").addEventListener("click", (e) => {
    const b = e.target.closest("[data-remove]");
    if (!b) return;
    if (b.dataset.remove === "photo") state.modalPhoto = null;
    else state.modalVoice = null;
    renderMediaPreview();
  });

  // 設定
  $("#saveProfile").addEventListener("click", saveProfile);
  $("#restoreBtn").addEventListener("click", () => $("#restoreFile").click());
  $("#restoreFile").addEventListener("change", (e) => { if (e.target.files[0]) doRestore(e.target.files[0]); e.target.value = ""; });
  const lo = $("#logoutBtn");
  if (lo) lo.addEventListener("click", () => (location.href = "/logout"));

  // 圖表範圍
  $$("#rangeTabs button").forEach((b) => b.addEventListener("click", () => {
    state.chartRange = Number(b.dataset.range); renderCharts();
  }));
}

async function main() {
  bindEvents();
  await bootProfile();
  // 若有登出功能（設定了密碼），顯示登出按鈕
  renderToday();
}

document.addEventListener("DOMContentLoaded", main);
