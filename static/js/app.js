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
  modalItems: {},       // 復健表單勾選：{"1": 次數或 null}
  modalPeriod: "上午",  // 復健表單時段
  exInfoEx: null,       // 目前示範彈窗顯示的動作（語音朗讀用）
  schedule: null,       // 課表設定 {enabled, plan:{weekday:[items]}}
  editorDay: (new Date()).getDay(),  // 課表編輯中的星期（0=日）
  schedAddPeriod: "上午",
};

const WEEKDAYS = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
const PORD = { "上午": 0, "下午": 1, "晚上": 2 };
function cmpSchedItem(a, b) {
  const pa = PORD[a.period] ?? 3, pb = PORD[b.period] ?? 3;
  if (pa !== pb) return pa - pb;
  return (a.time || "").localeCompare(b.time || "");
}
function schedItemLabel(it) {
  if (it.kind === "exercise") {
    const e = EX_BY_N[String(it.ex)];
    const nm = e ? e.name : "動作" + it.ex;
    return nm + (it.count != null && it.count !== "" ? ` ×${fmtNum(it.count)}` : "");
  }
  return it.label || "（項目）";
}
function genId() {
  if (window.crypto && crypto.randomUUID) return "i" + crypto.randomUUID();
  return "i" + Date.now().toString(36) + Math.floor(Math.random() * 1e9).toString(36);
}

/* ----------------------------- 復健動作資料 --------------------------------------------
   1–9 來自「復健動作AB分解圖.pdf」；10–14 為家人提供的頭頸運動。gif 為 null 者僅顯示文字。 */
const EX_CATS = { "肌力訓練": "#2f6d5f", "進階運動": "#e0912f", "關節舒緩": "#4f6d9e", "頭頸運動": "#8a5cc4" };
const NECK_NOTE = "坐在有靠背的穩固椅子上、雙手扶好椅邊，用最安全、緩慢的速度進行。建議一天 2 組（早、晚各一組）。";
const EXERCISES = [
  { n: 1, name: "腳踝幫浦運動", cat: "肌力訓練", unit: "次", gif: "ex01.gif", how: "腳尖用力向上勾，再向下踩，像踩油門一樣，慢慢反覆做。", good: "促進血液循環、消除腫脹。" },
  { n: 2, name: "大腿壓毛巾", cat: "肌力訓練", unit: "次", gif: "ex02.gif", how: "膝蓋下墊捲好的毛巾。用大腿力量把膝蓋向下壓毛巾，撐 5–10 秒再放鬆。", good: "訓練大腿力量，保護膝蓋和髖關節。" },
  { n: 3, name: "直腿抬高", cat: "肌力訓練", unit: "次", gif: "ex03.gif", how: "開刀的腿保持打直，慢慢往上抬高約 20–30 公分，停 5 秒再慢慢放下。", good: "訓練大腿肌力，讓走路更有力。" },
  { n: 4, name: "坐姿抬腿（踢腿）", cat: "肌力訓練", unit: "次", gif: "ex04.gif", how: "坐滿椅子，把膝蓋慢慢打直踢平、腳尖上勾，停 5 秒再慢慢放下。", good: "加強大腿前側肌肉。" },
  { n: 5, name: "雙手高舉＋原地踏步", cat: "進階運動", unit: "次", gif: "ex05.gif", how: "雙手像投降一樣往上舉高，同時雙腳在原地輕輕踏步。", good: "活動肩膀與全身關節，增加心肺耐力。" },
  { n: 6, name: "繞肩膀", cat: "關節舒緩", unit: "圈", gif: "ex08.gif", how: "雙肩往上聳起，再往後、往下繞圈。向前 5 圈、向後 5 圈。", good: "放鬆長期推助行器而緊繃的肩膀。" },
  { n: 7, name: "推天抓空", cat: "關節舒緩", unit: "次", gif: "ex09.gif", how: "雙手向上舉高，同時手指用力張開，再握拳。反覆 10 次。", good: "活動手部與肩膀關節。" },
  { n: 8, name: "腳踝繞圈", cat: "關節舒緩", unit: "圈", gif: "ex10.gif", how: "腳稍微往前伸、腳跟點地，用大腳趾在空中畫圓圈，順逆時針各 5 圈。", good: "活動踝關節，幫助血液回流、消水腫。" },
  { n: 9, name: "坐姿抬腿（活動膝蓋）", cat: "關節舒緩", unit: "次", gif: "ex11.gif", how: "雙手扶椅邊，把膝蓋打直踢平、腳尖上勾，停 3 秒放下。兩腳輪流。", good: "輕鬆活動膝關節，保護髖關節。" },
  { n: 10, name: "頭部上下運動（點頭仰頭）", cat: "頭頸運動", unit: "次", gif: "ex06.gif", note: NECK_NOTE,
    how: "下看：頭慢慢向下，下巴盡量貼近胸口，感覺脖子後側拉筋，停 5 秒。上看：頭慢慢回正，再慢往上看（看到牆與天花板交界即可，勿過度仰頭），停 5 秒。上下交替算 1 次，做 10 次。", good: "放鬆肩頸、增加頸部前後活動度。" },
  { n: 11, name: "左右轉頭（看肩膀）", cat: "頭頸運動", unit: "次", gif: "ex07.gif", note: NECK_NOTE,
    how: "頭慢慢向右轉，眼睛看向右肩，停 5 秒；回正後再慢慢向左轉、看向左肩，停 5 秒。左右交替算 1 次，做 10 次。", good: "放鬆頸部、增加左右活動度。" },
  { n: 12, name: "左右側彎（耳朵貼肩膀）", cat: "頭頸運動", unit: "次", gif: null, note: NECK_NOTE,
    how: "臉朝正前方，右耳慢慢往右肩靠（肩膀放鬆、不聳肩），感覺左頸拉筋，停 5 秒；回正後換左耳往左肩靠，停 5 秒。左右交替算 1 次，做 10 次。", good: "伸展頸部兩側，減少僵硬。" },
  { n: 13, name: "雙手阻力壓頭（前後對抗）", cat: "頭頸運動", unit: "次", gif: null, note: NECK_NOTE,
    how: "前壓：雙手輕擋前額，頭想微微前低、手稍用力擋住讓頭不動，感覺脖子前側出力，維持 5 秒放鬆。後壓：雙手移到後腦勺，頭想微微後仰、手往前擋住，維持 5 秒放鬆。前、後各做 10 次。", good: "訓練頸部前後肌力。" },
  { n: 14, name: "單手溫和壓頭（側頸拉筋）", cat: "頭頸運動", unit: "次", gif: null, note: NECK_NOTE,
    how: "右手指尖輕放左耳上方（手抬不高可請家人在後方協助），極輕柔把頭往右肩方向側壓，到左頸有微緊、舒服的拉筋感，停 5 秒；換左手壓右側，停 5 秒。左右交替算 1 次，做 10 次。", good: "溫和牽拉側頸，放鬆緊繃。" },
];
const EX_BY_N = Object.fromEntries(EXERCISES.map((e) => [String(e.n), e]));
const EX_TOTAL = EXERCISES.length;
const PERIODS = ["上午", "下午", "晚上"];
const gifUrl = (f) => `/static/gif/${f}`;
function autoPeriod() {
  const h = new Date().getHours();
  return h < 12 ? "上午" : (h < 18 ? "下午" : "晚上");
}

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
  messages: () => api("GET", "/api/messages"),
  createMessage: (b) => api("POST", "/api/messages", b),
  deleteMessage: (id) => api("DELETE", `/api/messages/${id}`),
  schedule: () => api("GET", "/api/schedule"),
  saveSchedule: (b) => api("PUT", "/api/schedule", b),
  scheduleLog: (date) => api("GET", `/api/schedule/log?date=${date}`),
  scheduleCheck: (b) => api("POST", "/api/schedule/check", b),
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
  else if (name === "messages") renderMessages();
  else if (name === "settings") loadSettings();
}

/* ----------------------------- 留言板 ----------------------------- */
function fmtStamp(s) {
  // created_at 是 UTC "YYYY-MM-DD HH:MM:SS"，轉成當地時間顯示
  if (!s) return "";
  const d = new Date(s.replace(" ", "T") + "Z");
  if (isNaN(d)) return esc(s);
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function renderMessages() {
  const el = $("#messageList");
  if (!el) return;
  let rows;
  try { rows = await API.messages(); } catch (e) { toast(e.message); return; }
  setHeaderMsgs(rows);  // 同步更新頁首輪播
  if (!rows.length) {
    el.innerHTML = `<div class="empty">還沒有留言。<br>在上面寫幾句話給爸爸加油吧！💪</div>`;
    return;
  }
  el.innerHTML = rows.map((m) => `
    <div class="msg">
      <div class="msg__head">
        <span class="msg__author">${esc(m.author) || "家人"}</span>
        <span class="msg__time">${fmtStamp(m.created_at)}</span>
        <button class="msg__del" data-del-msg="${m.id}" aria-label="刪除">✕</button>
      </div>
      <div class="msg__text">${esc(m.text)}</div>
    </div>`).join("");
}

async function submitMessage() {
  const text = $("#msgText").value.trim();
  if (!text) { toast("請先寫一點留言"); return; }
  const author = $("#msgAuthor").value.trim();
  try {
    await API.createMessage({ author, text });
    $("#msgText").value = "";
    if (author) localStorage.setItem("rehab_msg_author", author);
    toast("已送出 ✔");
    renderMessages();
  } catch (e) { toast(e.message); }
}

async function deleteMessage(id) {
  if (!confirm("確定要刪除這則留言嗎？")) return;
  try { await API.deleteMessage(id); renderMessages(); }
  catch (e) { toast(e.message); }
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

  let summary, rehab, vitals, schedule;
  try {
    [summary, rehab, vitals, schedule] = await Promise.all([
      API.summary(state.today), API.rehab(state.today), API.vitals(state.today), API.schedule(),
    ]);
  } catch (e) { toast(e.message); return; }

  state.schedule = schedule;
  renderTimeline(rehab, vitals);

  const wd = String(parseDate(state.today).getDay());
  const hasTodayPlan = schedule && schedule.enabled && (((schedule.plan || {})[wd] || []).length > 0);
  if (hasTodayPlan) {
    $("#goals").hidden = true;
    await renderTodaySchedule();
  } else {
    // 未啟用課表、或這天沒排課表 → 顯示原本的 X/14 完成度
    $("#goals").hidden = false;
    $("#todaySchedule").innerHTML = "";
    renderCompletion(summary);
  }
}

/* 今日課表：依當天星期顯示，可打勾 */
async function renderTodaySchedule() {
  const el = $("#todaySchedule");
  const wd = parseDate(state.today).getDay();
  const items = (((state.schedule || {}).plan || {})[String(wd)] || []).slice().sort(cmpSchedItem);
  if (!items.length) {
    el.innerHTML = `<div class="sched-card"><div class="sched-card__title">🗓 今日課表 <span class="sched-day">${WEEKDAYS[wd]}</span></div>
      <div class="empty">這天還沒有安排，可到「設定 → 課表」新增。</div></div>`;
    return;
  }
  let doneIds = [];
  try { doneIds = await API.scheduleLog(state.today); } catch (_) {}
  const done = new Set(doneIds);
  const doneCount = items.filter((it) => done.has(it.id)).length;
  const pct = Math.round((doneCount / items.length) * 100);
  const rows = items.map((it) => {
    const isDone = done.has(it.id);
    const info = it.kind === "exercise" ? `<button type="button" class="ck-info" data-info="${esc(it.ex)}" aria-label="說明">ⓘ</button>` : "";
    const time = it.time ? `<span class="sched-time">${esc(it.time)}</span>` : "";
    return `<div class="sched-row${isDone ? " done" : ""}" data-sched="${esc(it.id)}">
        <button type="button" class="ck-box" data-schedtoggle="${esc(it.id)}" aria-label="完成">✓</button>
        <span class="sched-label" data-schedtoggle="${esc(it.id)}"><span class="rec-period">${esc(it.period)}</span>${time}${esc(schedItemLabel(it))}</span>${info}
      </div>`;
  }).join("");
  el.innerHTML = `<div class="sched-card ${doneCount >= items.length ? "is-done" : ""}">
      <div class="sched-card__top">
        <div class="sched-card__title">🗓 今日課表 <span class="sched-day">${WEEKDAYS[wd]}</span></div>
        <div class="goal-card__val"><b>${doneCount}</b><span class="goal"> / ${items.length}</span><span class="unit">項</span></div>
      </div>
      <div class="bar"><div class="bar__fill" style="width:${pct}%"></div></div>
      <div class="sched-list">${rows}</div>
    </div>`;
}

async function toggleSchedCheck(itemId) {
  const row = $(`#todaySchedule .sched-row[data-sched="${itemId}"]`);
  const nowDone = row && row.classList.contains("done");
  try {
    await API.scheduleCheck({ date: state.today, item_id: itemId, done: !nowDone });
    renderTodaySchedule();
  } catch (e) { toast(e.message); }
}

function renderCompletion(s) {
  const total = s.total || EX_TOTAL;
  const done = s.done || 0;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const full = total > 0 && done >= total;
  // 三個標準時段 + 後端可能回傳的其他 bucket（例如舊資料的「其他」），確保小計加得起來。
  const byp = s.by_period || {};
  const extra = Object.keys(byp).filter((k) => !PERIODS.includes(k));
  const chips = [...PERIODS, ...extra].map((p) => {
    const v = byp[p] || 0;
    return `<span class="pchip${v > 0 ? " on" : ""}">${esc(p)} ${v}/${total}</span>`;
  }).join("");
  $("#goals").innerHTML = `
    <div class="goal-card ${full ? "is-done" : ""}">
      <div class="goal-card__top">
        <div class="goal-card__name"><span class="emoji">🦵</span>今日復健完成度
          ${full ? '<span class="goal-card__done-tag">全部完成 🎉</span>' : ""}</div>
        <div class="goal-card__val"><b>${done}</b><span class="goal"> / ${total}</span><span class="unit">項</span></div>
      </div>
      <div class="bar"><div class="bar__fill" style="width:${pct}%"></div></div>
      <div class="pchips">${chips}</div>
    </div>`;
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
  const items = r.items || {};
  const keys = Object.keys(items).map(Number).sort((a, b) => a - b);
  const chips = keys.map((n) => {
    const e = EX_BY_N[String(n)];
    const nm = e ? e.name : "動作" + n;
    const c = items[String(n)];
    const cnt = (c != null && c !== "") ? ` ${fmtNum(c)}${e ? e.unit : ""}` : "";
    return `<span class="chip">${esc(nm)}${cnt}</span>`;
  });
  if (!chips.length) chips.push(`<span class="chip chip--empty">未勾選動作</span>`);
  const media = [];
  if (r.photo) media.push(`<img src="${esc(r.photo)}" alt="照片">`);
  if (r.voice) media.push(`<audio controls src="${esc(r.voice)}"></audio>`);
  const period = r.period ? `<span class="rec-period">${esc(r.period)}</span>` : "";
  return `
    <div class="rec" data-edit-rehab="${r.id}">
      <div class="rec__icon">🦵</div>
      <div class="rec__body">
        <div class="rec__time">${period}${esc(r.time || "")} <span class="rec-count">完成 ${keys.length} 項</span></div>
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

  // 復健：每日各時段「完成動作數」（distinct，滿分 11）
  // 時段不是三種標準值的（例如舊資料 period=""）歸到「其他」，與後端 summary 一致，不要塞進上午。
  const CHART_PERIODS = ["上午", "下午", "晚上", "其他"];
  const PCOLORS = { "上午": "#2f6d5f", "下午": "#4f9d8a", "晚上": "#9cc3b8", "其他": "#bcae97" };
  const perSeries = {}; CHART_PERIODS.forEach((p) => (perSeries[p] = blank()));
  const perSets = {}; // "index|時段" -> Set(動作編號)
  for (const r of rehab) {
    const i = idx.get(r.date); if (i === undefined) continue;
    const per = PERIODS.includes(r.period) ? r.period : "其他";
    const key = i + "|" + per;
    (perSets[key] = perSets[key] || new Set());
    for (const k of Object.keys(r.items || {})) perSets[key].add(k);
  }
  for (const key in perSets) {
    const [i, per] = key.split("|");
    perSeries[per][Number(i)] = perSets[key].size;
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

  const activePeriods = CHART_PERIODS.filter((p) => has(perSeries[p]));
  if (activePeriods.length) {
    html += chartCard("每日完成動作數（依時段）", `上午 / 下午 / 晚上，滿分 ${EX_TOTAL} 項`,
      buildChart({ type: "bar", labels, series: activePeriods.map((p) => ({ name: p, color: PCOLORS[p], values: perSeries[p] })) }));
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
  let p, sc;
  try { [p, sc] = await Promise.all([API.profile(), API.schedule()]); }
  catch (e) { toast(e.message); return; }
  state.profile = p;
  state.schedule = sc;
  $("#pName").value = p.name || "";
  $("#pStart").value = p.start_date || "";
  renderExerciseGuide();
  populateSchedExerciseSelect();
  schedTypeChange();
  renderScheduleEditor();
}

/* ----------------------------- 課表編輯 ----------------------------- */
function populateSchedExerciseSelect() {
  const sel = $("#schedAddEx");
  if (!sel || sel.dataset.ready) return;
  let html = "";
  for (const cat of Object.keys(EX_CATS)) {
    const list = EXERCISES.filter((e) => e.cat === cat);
    html += `<optgroup label="${esc(cat)}">` +
      list.map((e) => `<option value="${e.n}">${e.n}. ${esc(e.name)}</option>`).join("") + `</optgroup>`;
  }
  sel.innerHTML = html;
  sel.dataset.ready = "1";
}

function schedTypeChange() {
  const isEx = $("#schedAddType").value === "exercise";
  $("#schedAddExWrap").hidden = !isEx;
  $("#schedAddCountWrap").hidden = !isEx;
  $("#schedAddCustomWrap").hidden = isEx;
}

function ensureSchedule() {
  if (!state.schedule) state.schedule = { enabled: false, plan: {} };
  if (!state.schedule.plan) state.schedule.plan = {};
  return state.schedule;
}

let schedSaveChain = Promise.resolve();
function saveScheduleNow() {
  const sc = ensureSchedule();
  // 快照當下內容並串接，確保多次快速編輯依序寫入、不會被較舊的 PUT 蓋過。
  const payload = { enabled: !!sc.enabled, plan: JSON.parse(JSON.stringify(sc.plan || {})) };
  schedSaveChain = schedSaveChain
    .then(() => API.saveSchedule(payload))
    .catch((e) => toast(e.message));
  return schedSaveChain;
}

function renderScheduleEditor() {
  const sc = ensureSchedule();
  $("#schedEnabled").checked = !!sc.enabled;
  $("#schedDayName").textContent = WEEKDAYS[state.editorDay];
  $$("#schedDay button").forEach((b) => b.classList.toggle("is-active", Number(b.dataset.wd) === state.editorDay));
  const items = (sc.plan[String(state.editorDay)] || []).slice().sort(cmpSchedItem);
  const el = $("#schedItems");
  el.innerHTML = items.length
    ? items.map((it) => `<div class="sched-edit-row">
        <span class="rec-period">${esc(it.period)}</span>
        ${it.time ? `<span class="sched-time">${esc(it.time)}</span>` : ""}
        <span class="sched-edit-label">${esc(schedItemLabel(it))}</span>
        <button type="button" class="sched-del" data-scheddel="${esc(it.id)}" aria-label="刪除">✕</button>
      </div>`).join("")
    : `<div class="empty" style="padding:14px 6px">這天還沒有項目，用下面新增。</div>`;
}

function schedAddItem() {
  const sc = ensureSchedule();
  const wd = String(state.editorDay);
  if (!sc.plan[wd]) sc.plan[wd] = [];
  const type = $("#schedAddType").value;
  const item = { id: genId(), period: state.schedAddPeriod, time: $("#schedAddTime").value || "" };
  if (type === "exercise") {
    item.kind = "exercise";
    item.ex = Number($("#schedAddEx").value);
    const c = $("#schedAddCount").value;
    item.count = c === "" ? null : Number(c);
  } else {
    const label = $("#schedAddCustom").value.trim();
    if (!label) { toast("請輸入自訂內容"); return; }
    item.kind = "custom";
    item.label = label;
  }
  sc.plan[wd].push(item);
  saveScheduleNow();
  renderScheduleEditor();
  $("#schedAddTime").value = ""; $("#schedAddCount").value = ""; $("#schedAddCustom").value = "";
  toast("已加入");
}

function schedDelItem(id) {
  const sc = ensureSchedule();
  const wd = String(state.editorDay);
  sc.plan[wd] = (sc.plan[wd] || []).filter((it) => it.id !== id);
  saveScheduleNow();
  renderScheduleEditor();
}

function schedToggleEnabled() {
  ensureSchedule().enabled = $("#schedEnabled").checked;
  saveScheduleNow();
}

function schedCopyToAll() {
  const sc = ensureSchedule();
  const src = sc.plan[String(state.editorDay)] || [];
  if (!src.length) { toast("這天沒有項目可複製"); return; }
  if (!confirm(`要把「${WEEKDAYS[state.editorDay]}」的課表複製到每一天嗎？（會覆蓋其他天）`)) return;
  for (let d = 0; d < 7; d++) {
    if (d === state.editorDay) continue;  // 來源這天不動，才不會弄丟今天的打勾
    sc.plan[String(d)] = src.map((it) => ({ ...it, id: genId() }));
  }
  saveScheduleNow();
  renderScheduleEditor();
  toast("已複製到每一天");
}

async function saveProfile() {
  const body = { name: $("#pName").value.trim(), start_date: $("#pStart").value };
  try {
    state.profile = await API.saveProfile(body);
    updateHeaderName();
    const h = $("#profileSaved"); h.hidden = false; setTimeout(() => (h.hidden = true), 1800);
    toast("已儲存 ✔");
  } catch (e) { toast(e.message); }
}

/* 設定頁的動作說明清單 */
function renderExerciseGuide() {
  const el = $("#exerciseGuide");
  if (!el) return;
  el.innerHTML = EXERCISES.map((e) => `
    <button type="button" class="ex-guide-item" data-info="${e.n}">
      <span class="ex-guide-n" style="background:${EX_CATS[e.cat]}">${e.n}</span>
      <span class="ex-guide-name">${esc(e.name)}</span>
      <span class="ex-guide-cat" style="color:${EX_CATS[e.cat]}">${esc(e.cat)}</span>
    </button>`).join("");
}

/* ----------------------------- 復健動作勾選清單 ----------------------------- */
function renderChecklist() {
  let html = "";
  for (const cat of Object.keys(EX_CATS)) {
    const list = EXERCISES.filter((e) => e.cat === cat);
    if (!list.length) continue;
    html += `<div class="ck-cat" style="--cat:${EX_CATS[cat]}">${cat}</div>`;
    for (const e of list) {
      const k = String(e.n);
      const done = k in state.modalItems;
      const val = done && state.modalItems[k] != null ? state.modalItems[k] : "";
      html += `
        <div class="ck-row${done ? " done" : ""}" data-ex="${e.n}" style="--cat:${EX_CATS[cat]}">
          <button type="button" class="ck-box" data-toggle="${e.n}" aria-label="完成">✓</button>
          <span class="ck-name" data-toggle="${e.n}">${esc(e.name)}</span>
          <input class="ck-count" type="number" min="0" inputmode="numeric" data-count="${e.n}" placeholder="${e.unit}" value="${val}">
          <button type="button" class="ck-info" data-info="${e.n}" aria-label="動作說明">ⓘ</button>
        </div>`;
    }
  }
  $("#rChecklist").innerHTML = html;
}

function ckRowState(n) {
  const row = $(`#rChecklist .ck-row[data-ex="${n}"]`);
  if (row) row.classList.toggle("done", String(n) in state.modalItems);
}

function toggleExercise(n) {
  const k = String(n);
  if (k in state.modalItems) {
    delete state.modalItems[k];
  } else {
    const inp = $(`#rChecklist [data-count="${n}"]`);
    const v = inp && inp.value !== "" ? Number(inp.value) : null;
    state.modalItems[k] = (v != null && isFinite(v)) ? v : null;
  }
  ckRowState(n);
}

function setExerciseCount(n, raw) {
  const k = String(n);
  if (raw === "") {
    if (k in state.modalItems) state.modalItems[k] = null;  // 有勾但清空次數
  } else {
    const v = Number(raw);
    state.modalItems[k] = isFinite(v) ? v : null;           // 填次數 = 自動勾選
  }
  ckRowState(n);
}

function setPeriodSeg(p) {
  state.modalPeriod = p;
  $$("#rPeriod button").forEach((b) => b.classList.toggle("is-active", b.dataset.period === p));
}

/* 動作示範彈窗（GIF + 做法 + 好處 + 語音朗讀） */
function openExInfo(n) {
  const e = EX_BY_N[String(n)];
  if (!e) return;
  stopSpeak();
  state.exInfoEx = e;
  $("#exInfoTitle").textContent = `${e.n}. ${e.name}`;
  const gif = e.gif ? `<img class="ex-gif" src="${gifUrl(e.gif)}" alt="${esc(e.name)} 示範動畫" loading="lazy">` : "";
  const note = e.note ? `<div class="ex-note">🪑 ${esc(e.note)}</div>` : "";
  $("#exInfoBody").innerHTML = `
    <div class="ex-cat-tag" style="background:${EX_CATS[e.cat]}">${esc(e.cat)}</div>
    ${gif}${note}
    <div class="ex-sec"><h4>怎麼做</h4><p>${esc(e.how)}</p></div>
    <div class="ex-good">好處：${esc(e.good)}</div>`;
  const sb = $("#exSpeakBtn");
  if (sb) sb.style.display = speakSupported() ? "" : "none";
  $("#exInfoModal").hidden = false;
  document.body.style.overflow = "hidden";
}
function closeExInfo() {
  stopSpeak();
  $("#exInfoModal").hidden = true;
  if ($("#rehabModal").hidden) document.body.style.overflow = "";  // 若復健表單仍開著，維持鎖定
}

/* ----------------------------- 語音朗讀（用裝置內建 TTS，免檔案） ----------------------------- */
function speakSupported() {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}
// 只選「國語（Mandarin）」，並明確排除粵語（zh-HK / yue / Sin-ji 等）。
// iPad 上常有 zh-HK 粵語語音，一旦被選到就會用廣東話唸，所以要濾掉。
function isCantonese(v) {
  return /(^|[-_])(hk|yue)\b/i.test(v.lang || "") ||
         /yue|粵|廣東|cantonese|sin[\-\s]?ji/i.test(v.name || "");
}
function pickZhVoice() {
  const vs = window.speechSynthesis.getVoices() || [];
  const mandarin = vs.filter((v) => /^(zh|cmn)/i.test(v.lang || "") && !isCantonese(v));
  return mandarin.find((v) => /zh[-_](tw|hant)/i.test(v.lang)) ||   // 台灣國語優先
         mandarin.find((v) => /zh[-_](cn|hans)/i.test(v.lang)) ||   // 其次大陸國語
         mandarin[0] || null;
}
function stopSpeak() {
  if (speakSupported()) window.speechSynthesis.cancel();
  const b = $("#exSpeakBtn");
  if (b) { b.classList.remove("is-speaking"); b.textContent = "🔊 唸給我聽"; }
}
function exSpeechText(e) {
  let t = e.name + "。";
  if (e.note) t += e.note + " ";
  t += "怎麼做。" + e.how + " 好處。" + e.good;
  return t;
}
function toggleSpeak() {
  if (!speakSupported()) { toast("這個裝置不支援語音朗讀"); return; }
  const b = $("#exSpeakBtn");
  if (b && b.classList.contains("is-speaking")) { stopSpeak(); return; }
  window.speechSynthesis.cancel();
  const e = state.exInfoEx;
  if (!e) return;
  const u = new SpeechSynthesisUtterance(exSpeechText(e));
  u.lang = "zh-TW";  // 國語（台灣）
  u.rate = 0.85;  // 放慢一點，長輩比較聽得清楚
  const v = pickZhVoice();
  if (v) { u.voice = v; u.lang = v.lang || "zh-TW"; }  // 用選到的國語語音，語言也對齊避免退回粵語
  u.onend = stopSpeak;
  u.onerror = stopSpeak;
  if (b) { b.classList.add("is-speaking"); b.textContent = "⏸ 停止"; }
  window.speechSynthesis.speak(u);
}

/* 頁首輪播：名字問候 + 家人留言（格式「留言者：內容」），每 6 秒換一則 */
const HEADER_ROTATE_MS = 6000;

function headerLineFor(m) {
  const t = String(m.text || "").replace(/\s+/g, " ").trim();
  const s = `${(m.author || "").trim() || "家人"}：${t}`;
  return s.length > 26 ? s.slice(0, 25) + "…" : s;
}

function rebuildHeaderItems() {
  const el = $("#headerName");
  const items = [];
  const n = state.profile && state.profile.name;
  if (n) items.push(`${n} · 加油！`);
  for (const m of state.headerMsgs || []) items.push(headerLineFor(m));
  state.headerItems = items;
  state.headerIdx = 0;
  clearInterval(state.headerTimer);
  if (!items.length) { el.textContent = ""; return; }
  el.textContent = items[0];
  el.style.opacity = "1";
  if (items.length > 1) {
    state.headerTimer = setInterval(() => {
      state.headerIdx = (state.headerIdx + 1) % state.headerItems.length;
      el.style.opacity = "0";
      setTimeout(() => {
        el.textContent = state.headerItems[state.headerIdx];  // textContent，不經 innerHTML，留言內容不會被當 HTML
        el.style.opacity = "1";
      }, 350);
    }, HEADER_ROTATE_MS);
  }
}

function setHeaderMsgs(rows) {
  state.headerMsgs = Array.isArray(rows) ? rows.slice(0, 10) : [];  // 最新 10 則進輪播
  rebuildHeaderItems();
}

function updateHeaderName() {
  rebuildHeaderItems();
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
  state.modalItems = entry && entry.items ? { ...entry.items } : {};
  state.modalPeriod = entry && entry.period ? entry.period : autoPeriod();
  $("#rehabModalTitle").textContent = entry ? "編輯復健紀錄" : "新增復健紀錄";
  $("#rehabId").value = entry ? entry.id : "";
  $("#rDate").value = entry ? entry.date : state.today;
  $("#rTime").value = entry ? (entry.time || "") : localTimeStr();
  $("#rNotes").value = entry ? (entry.notes || "") : "";
  $("#rPhoto").value = "";
  $("#rehabDelete").hidden = !entry;
  setPeriodSeg(state.modalPeriod);
  renderChecklist();
  renderMediaPreview();
  openModal("rehabModal");
}

async function saveRehab() {
  const body = {
    date: $("#rDate").value || state.today,
    period: state.modalPeriod,
    time: $("#rTime").value,
    items: state.modalItems,
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
  try {
    const [p, msgs] = await Promise.all([API.profile(), API.messages().catch(() => [])]);
    state.profile = p;
    setHeaderMsgs(msgs);
  } catch (_) {}
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

  // 點擊「動作說明」(ⓘ) → 開示範彈窗（清單與設定頁共用）
  document.addEventListener("click", async (e) => {
    const info = e.target.closest("[data-info]");
    if (info) { openExInfo(info.dataset.info); return; }
    const dm = e.target.closest("[data-del-msg]");
    if (dm) { deleteMessage(Number(dm.dataset.delMsg)); return; }
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
  $$("[data-close-ex]").forEach((b) => b.addEventListener("click", closeExInfo));
  $("#exSpeakBtn").addEventListener("click", toggleSpeak);

  // 復健表單：時段選擇
  $("#rPeriod").addEventListener("click", (e) => {
    const b = e.target.closest("[data-period]");
    if (b) setPeriodSeg(b.dataset.period);
  });

  // 復健表單：動作打勾 / 填次數
  $("#rChecklist").addEventListener("click", (e) => {
    const t = e.target.closest("[data-toggle]");
    if (t) toggleExercise(t.dataset.toggle);
  });
  $("#rChecklist").addEventListener("input", (e) => {
    const c = e.target.closest("[data-count]");
    if (c) setExerciseCount(c.dataset.count, c.value);
  });

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

  // 留言板
  $("#msgSend").addEventListener("click", submitMessage);
  const savedAuthor = localStorage.getItem("rehab_msg_author");
  if (savedAuthor) $("#msgAuthor").value = savedAuthor;

  // 今日課表打勾
  $("#todaySchedule").addEventListener("click", (e) => {
    const t = e.target.closest("[data-schedtoggle]");
    if (t) toggleSchedCheck(t.dataset.schedtoggle);
  });

  // 課表編輯（設定頁）
  $("#schedEnabled").addEventListener("change", schedToggleEnabled);
  $("#schedDay").addEventListener("click", (e) => {
    const b = e.target.closest("[data-wd]");
    if (b) { state.editorDay = Number(b.dataset.wd); renderScheduleEditor(); }
  });
  $("#schedAddPeriod").addEventListener("click", (e) => {
    const b = e.target.closest("[data-p]");
    if (b) { state.schedAddPeriod = b.dataset.p; $$("#schedAddPeriod button").forEach((x) => x.classList.toggle("is-active", x === b)); }
  });
  $("#schedAddType").addEventListener("change", schedTypeChange);
  $("#schedAddBtn").addEventListener("click", schedAddItem);
  $("#schedItems").addEventListener("click", (e) => {
    const b = e.target.closest("[data-scheddel]");
    if (b) schedDelItem(b.dataset.scheddel);
  });
  $("#schedCopyAll").addEventListener("click", schedCopyToAll);
}

async function main() {
  bindEvents();
  await bootProfile();
  // 若有登出功能（設定了密碼），顯示登出按鈕
  renderToday();
}

document.addEventListener("DOMContentLoaded", main);
