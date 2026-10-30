"use strict";


/* ================= ХРАНИЛИЩЕ ================= */
const STORAGE_KEY = "healthDiary.v2";
const OLD_KEY = "healthDiary.v1";
let ACCOUNT_KEY = null; // uid вошедшего пользователя (данные хранятся отдельно)

const DEFAULT_SETTINGS = {
  goalCal: 0, goalP: 0, goalF: 0, goalC: 0,
  goalWeight: null,
  mealNames: ["Завтрак", "Обед", "Ужин", "Перекус"],
  firebaseConfig: "", autoSync: true,
  sex: "м", height: 0, age: 0, mode: "",
  hiddenRecs: [],
  restSec: 90,       // отдых между подходами по умолчанию, сек
  restAuto: true     // автозапуск таймера после записи подхода
};

function defaultData() {
  return {
    foods: [], weights: [], workouts: [],
    customFoods: [],
    plans: [],
    mealPlan: {},        // дата -> [{id, meal, name, grams, cal, p, f, c}]
    settings: JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
    updatedAt: 0
  };
}

function migrateOld() {
  try {
    const old = JSON.parse(store.getItem(OLD_KEY) || "null");
    if (!old) return null;
    const d = defaultData();
    (old.foods || []).forEach(f => d.foods.push({
      id: f.id || uid(), date: f.date, meal: f.meal || "Обед",
      name: f.name || "Без названия", grams: null,
      cal: num(f.calories), p: num(f.protein), f: num(f.fat), c: num(f.carbs)
    }));
    (old.weights || []).forEach(w => d.weights.push({ id: w.id || uid(), date: w.date, kg: Number(w.kg), createdAt: w.createdAt || Date.now() }));
    (old.workouts || []).forEach(w => d.workouts.push({ id: w.id || uid(), date: w.date, name: w.name, minutes: num(w.minutes), cal: num(w.calories), details: w.details || "" }));
    return d;
  } catch { return null; }
}
function loadData() {
  try {
    const raw = store.getItem(ACCOUNT_KEY || STORAGE_KEY);
    if (raw) {
      const d = Object.assign(defaultData(), JSON.parse(raw));
      d.settings = Object.assign(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), d.settings || {});
      d.del = d.del || {};
      return d;
    }
    const migrated = migrateOld();
    if (migrated) return migrated;
    return defaultData();
  } catch { return defaultData(); }
}

let data = loadData();
let selectedDate = todayStr();
let currentTab = "diary";
let pendingSaveSync = null;

/* ================= ТАЙМЕР ОТДЫХА ================= */
let rest = { timer: null, endsAt: 0, total: 0, remaining: 0, running: false };

function restFmt(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const m = Math.floor(sec / 60), s = sec % 60;
  return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
}
function restReadSec() {
  const sel = $("#restDur"), custom = $("#restCustom");
  let sec = sel ? +sel.value : 0;
  if (sel && sel.value === "custom" && custom) sec = num(custom.value);
  if (!Number.isFinite(sec) || sec <= 0) sec = num(data.settings.restSec) || 90;
  return Math.min(3600, Math.max(5, Math.round(sec)));
}
function restDraw() {
  const el = $("#restTime");
  if (!el) return;
  const left = rest.running ? Math.max(0, Math.ceil((rest.endsAt - Date.now()) / 1000)) : rest.remaining;
  el.textContent = restFmt(left);
  const b = $("#restToggleBtn");
  if (b) b.textContent = rest.running ? "Пауза" : (rest.remaining > 0 && rest.remaining < rest.total ? "Продолжить" : "Старт");
}
function restDoneNotify() {
  try { navigator.vibrate && navigator.vibrate([180, 80, 180, 80, 260]); } catch {}
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.frequency.value = 880;
    const t = ctx.currentTime;
    g.gain.setValueAtTime(0.001, t);
    g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.8);
    o.start(t); o.stop(t + 0.85);
  } catch {}
  toast("Отдых окончен — можно следующий подход");
}
function restTick() {
  const left = Math.ceil((rest.endsAt - Date.now()) / 1000);
  if (left <= 0) {
    clearInterval(rest.timer); rest.timer = null;
    rest.running = false; rest.remaining = 0;
    restDraw(); restDoneNotify();
  } else restDraw();
}
function restStart(sec) {
  clearInterval(rest.timer);
  sec = Math.min(3600, Math.max(5, Math.round(sec || 90)));
  data.settings.restSec = sec;
  rest.total = sec; rest.remaining = sec;
  rest.endsAt = Date.now() + sec * 1000;
  rest.running = true;
  rest.timer = setInterval(restTick, 250);
  persist();
  restDraw();
}
function restToggle() {
  if (rest.running) {
    rest.remaining = Math.max(0, Math.ceil((rest.endsAt - Date.now()) / 1000));
    rest.running = false;
    clearInterval(rest.timer); rest.timer = null;
    restDraw();
    return;
  }
  if (!rest.remaining) rest.remaining = restReadSec();
  if (!rest.total) rest.total = rest.remaining;
  rest.endsAt = Date.now() + rest.remaining * 1000;
  rest.running = true;
  rest.timer = setInterval(restTick, 250);
  restDraw();
}
function restReset() {
  clearInterval(rest.timer); rest.timer = null;
  rest.running = false;
  const sec = $("#restTime") ? restReadSec() : (num(data.settings.restSec) || 90);
  rest.total = sec; rest.remaining = sec;
  restDraw();
}

function persist() {
  data.updatedAt = Date.now();
  try { store.setItem(ACCOUNT_KEY || STORAGE_KEY, JSON.stringify(data)); } catch (e) { toast("Не удалось сохранить данные (память браузера заполнена?)", true); }
  scheduleAutoSync();
}
// пометка записи времени изменения (для корректного слияния устройств)
function touch(rec) { rec.u = Date.now(); return rec; }
// «могильные камни» удалённых записей — чтобы удаления синхронизировались
function tombstone(id) {
  data.del = data.del || {};
  data.del[id] = Date.now();
}
function purgeTombstones() {
  if (!data.del) return;
  const cutoff = Date.now() - 90 * 86400000;
  for (const k of Object.keys(data.del)) if (data.del[k] < cutoff) delete data.del[k];
}

/* ================= ХЕЛПЕРЫ ================= */
function $(sel, root) { return (root || document).querySelector(sel); }
function $$(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
}
function num(v) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; }
function fmtNum(v) {
  const r = Math.round(v * 10) / 10;
  return (Number.isInteger(r) ? String(r) : r.toFixed(1)).replace(".", ",");
}
const ENT_AMP = String.fromCharCode(38);
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, ENT_AMP + "amp;")
    .replace(/</g, ENT_AMP + "lt;")
    .replace(/>/g, ENT_AMP + "gt;")
    .replace(/"/g, ENT_AMP + "quot;")
    .replace(/'/g, String.fromCharCode(39));
}
function todayStr() {
  const d = new Date(), off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
}
function shiftDate(iso, days) {
  const d = new Date(iso + "T12:00:00");
  d.setDate(d.getDate() + days);
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
}
function fmtDateRu(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${["января","февраля","марта","апреля","мая","июня","июля","августа","сентября","октября","ноября","декабря"][m - 1]} ${y}`;
}
function fmtDateShort(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return `${String(d).padStart(2, "0")}.${String(m).padStart(2, "0")}`;
}
function fmtDateFullShort(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return `${String(d).padStart(2, "0")}.${String(m).padStart(2, "0")}.${y}`;
}
function plural(n, one, few, many) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}
function toast(msg, isErr) {
  const root = $("#toast-root");
  const el = document.createElement("div");
  el.className = "toast" + (isErr ? " err" : "");
  if (isErr) el.textContent = msg;
  else el.innerHTML = `<img class="toast-ico" src="art/sticker-check.png" alt="">${esc(msg)}`;
  root.appendChild(el);
  setTimeout(() => { el.style.opacity = "0"; el.style.transition = "opacity .4s"; }, 2600);
  setTimeout(() => el.remove(), 3100);
}
function sum(arr, key) { return arr.reduce((s, x) => s + num(x[key]), 0); }
function macroCal(p, f, c) { return Math.round(4 * num(p) + 9 * num(f) + 4 * num(c)); }
function round1(v) { return Math.round(v * 10) / 10; }
function normExName(s) { return String(s == null ? "" : s).toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim(); }
function workoutExercises(w) { return Array.isArray(w && w.exercises) ? w.exercises : []; }
function sortedWorkouts() { return [...data.workouts].sort((a, b) => b.date.localeCompare(a.date) || (b.startedAt || 0) - (a.startedAt || 0)); }
function fmtSet(s) {
  const w = s && (s.weight == null || s.weight === "") ? null : num(s.weight);
  let reps = s && s.reps != null ? String(s.reps) : "";
  if (s && s.toFailure) reps = "до отказа";
  return w ? `${fmtNum(w)} кг × ${reps}` : (reps || "—");
}
function setsLine(sets) { return (sets || []).map(fmtSet).join(" · "); }
// последний раз, когда делали это упражнение (до текущей тренировки w) — берём только записи с подходами
function lastSetsFor(exName, w) {
  const n = normExName(exName);
  if (!n) return null;
  const hasSets = x => {
    const ex = workoutExercises(x).find(e => normExName(e.name) === n);
    return ex && ex.sets && ex.sets.length ? ex : null;
  };
  const cands = data.workouts.filter(x =>
    x.id !== w.id && hasSets(x) &&
    (x.date < w.date || (x.date === w.date && (x.startedAt || 0) < (w.startedAt || Date.now())))
  ).sort((a, b) => b.date.localeCompare(a.date) || (b.startedAt || 0) - (a.startedAt || 0));
  const prev = cands[0];
  if (!prev) return null;
  const ex = hasSets(prev);
  return { date: prev.date, sets: ex.sets };
}
function workoutBodyHtml(w) {
  const exs = workoutExercises(w);
  if (exs.length) return exs.map(e => `<div class="item" style="cursor:pointer" data-action="exProgress" data-name="${esc(e.name)}"><div class="item-main"><div class="name" style="font-weight:600;font-size:14.5px">${esc(e.name)}</div><small>${esc(setsLine(e.sets)) || "подходы не записаны"}${e.note ? ` · 📝 ${esc(e.note)}` : ""}</small></div><span class="kcal">📈</span></div>`).join("");
  if (w.details) return `<div class="workout-details" style="margin-top:8px;padding:10px;background:var(--panel-2);border:1px solid var(--border);border-radius:10px;white-space:pre-line;font-size:14px">${esc(w.details)}</div>`;
  return "";
}

/* ---------- Прогресс упражнения: все подходы по датам ---------- */
function openExProgress(name) {
  const n = normExName(name);
  const rows = [];
  data.workouts.forEach(w => {
    workoutExercises(w).forEach(ex => {
      if (normExName(ex.name) !== n || !ex.sets || !ex.sets.length) return;
      const best = ex.sets.reduce((b, s) => {
        const wgt = num(s.weight), reps = parseFloat(String(s.reps || "").replace(",", ".")) || 0;
        return wgt * reps > b.vol ? { vol: wgt * reps, wgt, reps } : b;
      }, { vol: 0, wgt: 0, reps: 0 });
      rows.push({ date: w.date, note: ex.note || "", sets: ex.sets, best });
    });
  });
  rows.sort((a, b) => a.date.localeCompare(b.date));
  openModal(`
    <div class="modal-head"><h3>📈 ${esc(name)}</h3><button class="close-x" data-action="closeModal">✕</button></div>
    ${rows.length ? `<div class="hint" style="margin:0 0 10px">${rows.length} ${plural(rows.length, "тренировка", "тренировки", "тренировок")} с этим упражнением. Лучший подход по объёму помечен ⭐.</div>
      <div class="list">${rows.map((r, i) => {
        const prev = i ? rows[i - 1].best.vol : null;
        const delta = prev ? Math.round((r.best.vol - prev) / (prev || 1) * 100) : null;
        const dTxt = delta == null ? "" : delta > 0 ? ` <span style="color:var(--green)">▲ +${delta}%</span>` : delta < 0 ? ` <span style="color:var(--danger)">▼ ${delta}%</span>` : ` <span>—</span>`;
        const bestTxt = r.best.wgt ? `${fmtNum(r.best.wgt)} кг × ${r.best.reps}` : `${r.best.reps} повт`;
        return `<div class="item"><div class="item-main"><div class="name">${fmtDateRu(r.date)}${r.note ? ` · 📝 ${esc(r.note)}` : ""}</div><small>${esc(setsLine(r.sets))}</small></div><span class="kcal">${bestTxt}${dTxt}</span></div>`;
      }).join("")}</div>`
    : `<div class="empty">Нет записей с таким упражнением.</div>`}`);
}

/* ================= МОДАЛКИ ================= */
function openModal(html, opts) {
  opts = opts || {};
  const root = $("#modal-root");
  root.innerHTML = `<div class="modal-overlay${opts.center ? " center" : ""}"><div class="modal">${html}</div></div>`;
  const overlay = $(".modal-overlay", root);
  overlay.addEventListener("click", e => { if (e.target === overlay) closeModal(); });
  document.body.style.overflow = "hidden";
  return root;
}
function closeModal() {
  $("#modal-root").innerHTML = "";
  document.body.style.overflow = "";
  stopBarcodeScan();
}

/* ================= РЕНДЕР ОСНОВНОЙ ================= */
function switchTab(tab) {
  currentTab = tab;
  $$(".view").forEach(v => v.classList.remove("active"));
  $("#view-" + tab).classList.add("active");
  $$(".tabbar button").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  const subs = { diary: "Питание · КБЖУ", workouts: "Тренировки и планы", progress: "Графики и прогноз", mealplan: "Планирование рациона", settings: "Настройки и синхронизация", api: "Проверка API ключа" };
  $("#headerSub").textContent = subs[tab] || "";
  renderAll();
  window.scrollTo({ top: 0 });
}

function renderAll() {
  renderDiary();
  renderWorkouts();
  renderProgress();
  renderMealPlan();
  renderSettings();
}

function refresh() { persist(); renderAll(); }

/* ================= ДНЕВНИК ================= */
function foodsFor(date) { return data.foods.filter(f => f.date === date); }

function renderDiary() {
  const day = selectedDate;
  const foods = foodsFor(day);
  const cal = sum(foods, "cal"), p = sum(foods, "p"), f = sum(foods, "f"), c = sum(foods, "c");
  const s = data.settings;
  const goalCal = num(s.goalCal);

  // карточки-сводка
  let calSub = "";
  if (goalCal) {
    const pct = Math.min(100, Math.round(cal / goalCal * 100));
    calSub = `${Math.round(cal)} / ${goalCal} ккал · ${pct}%`;
    if (s.mode === "deficit") calSub += " 🔻 дефицит";
    else if (s.mode === "surplus") calSub += " 🔺 профицит";
    else if (s.mode === "maintain") calSub += " ⚖️ поддержание";
  } else calSub = "задай цель в настройках";
  const pctBar = goalCal ? Math.min(100, Math.round(cal / goalCal * 100)) : 0;
  $("#summaryCards").innerHTML = `
    <div class="card accent"><span>Калории за день</span><strong>${Math.round(cal)} ккал</strong>
      <div class="progress-wrap"><div class="progress-bar${goalCal && cal > goalCal ? " over" : ""}" style="width:${pctBar}%"></div></div>
      <small>${calSub}</small></div>
    <div class="card"><span>Белки</span><strong>${fmtNum(p)} г</strong><small>${s.goalP ? "цель " + fmtNum(s.goalP) + " г" : ""}</small></div>
    <div class="card"><span>Жиры</span><strong>${fmtNum(f)} г</strong><small>${s.goalF ? "цель " + fmtNum(s.goalF) + " г" : ""}</small></div>
    <div class="card"><span>Углеводы</span><strong>${fmtNum(c)} г</strong><small>${s.goalC ? "цель " + fmtNum(s.goalC) + " г" : ""}</small></div>`;

  $("#dateInput").value = day;

  // приёмы пищи
  const names = s.mealNames.length ? s.mealNames : ["Завтрак", "Обед", "Ужин", "Перекус"];
  $("#mealSections").innerHTML = names.map(meal => {
    const items = foods.filter(x => x.meal === meal);
    const mCal = sum(items, "cal");
    return `<div class="meal-block">
      <div class="meal-head">${mealIcon(meal)}<b>${esc(meal)}</b><span class="meal-kcal">${Math.round(mCal)} ккал</span></div>
      <div class="meal-body">
        ${items.length ? items.map(item => `
          <div class="item">
            <div class="item-main" data-action="editFood" data-id="${item.id}">
              <div class="name">${esc(item.name)}</div>
              <small>${item.grams ? item.grams + " г · " : ""}Б: ${fmtNum(item.p)} · Ж: ${fmtNum(item.f)} · У: ${fmtNum(item.c)}</small>
            </div>
            <div class="item-right"><span class="kcal">${Math.round(num(item.cal))} ккал</span>
              <button class="icon-btn" data-action="delFood" data-id="${item.id}">✕</button></div>
          </div>`).join("") : `<div class="empty meal-empty"><img class="mini-mascot" src="mascot/rest.png" alt="">Пока ничего здесь не записано</div>`}
        <div class="meal-actions">
          <button class="small primary" data-action="addFood" data-meal="${esc(meal)}">＋ Добавить еду</button>
          ${data.foods.some(f => f.meal === meal && f.date !== selectedDate) ? `<button class="small ghost" data-action="repeatMeal" data-meal="${esc(meal)}">⏪ Повторить</button>` : ""}
          ${items.length ? `<button class="small ghost" data-action="saveMealAsDish" data-meal="${esc(meal)}">💾 Сохранить как блюдо</button>` : ""}
        </div>
      </div>
    </div>`;
  }).join("");

  const latest = [...data.weights].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt)[0];
  $("#lastWeightInline").textContent = latest ? latest.kg.toFixed(1) + " кг (" + fmtDateShort(latest.date) + ")" : "нет записей";
}

/* ---------- Поиск еды ---------- */
let foodSearchCtx = { meal: "Обед", target: "diary" }; // target: diary | plan

function openFoodSearch(meal, target, tab) {
  foodSearchCtx = { meal: meal || (data.settings.mealNames[0] || "Обед"), target: target || "diary" };
  renderFoodSearch(tab || "search");
}

function renderFoodSearch(tab) {
  const names = data.settings.mealNames.length ? data.settings.mealNames : ["Завтрак", "Обед", "Ужин", "Перекус"];
  const mealSel = names.map(n => `<option${n === foodSearchCtx.meal ? " selected" : ""}>${esc(n)}</option>`).join("");
  const html = `
    <div class="modal-head"><h3>Добавить еду</h3><button class="close-x" data-action="closeModal">✕</button></div>
    <div class="modal-tabs">
      <button data-stab="search" class="${tab === "search" ? "active" : ""}">Поиск</button>
      <button data-stab="custom" class="${tab === "custom" ? "active" : ""}">Мои блюда</button>
      <button data-stab="barcode" class="${tab === "barcode" ? "active" : ""}">Штрихкод</button>
      <button data-stab="photo" class="${tab === "photo" ? "active" : ""}">Фото</button>
    </div>
    <div id="foodSearchBody"></div>`;
  openModal(html);
  $$("#modal-root .modal-tabs button").forEach(b => b.addEventListener("click", () => renderFoodSearch(b.dataset.stab)));

  const body = $("#foodSearchBody");

  if (tab === "search") {
    body.innerHTML = `
      <div class="search-row"><input id="foodQuery" placeholder="Например: гречка, творог, шаурма…" autocomplete="off"><button data-action="manualEntry">Вручную</button></div>
      <div class="hint" id="searchHint">Встроенная база (${FOOD_DB.length} продуктов) + Open Food Facts. Поиск по базе работает даже без интернета. Значения усреднённые, справочные.</div>
      <div id="foodResults"></div>`;
    const input = $("#foodQuery");
    let deb = null;
    input.addEventListener("input", () => {
      clearTimeout(deb);
      deb = setTimeout(() => runFoodSearch(input.value.trim()), 350);
    });
    input.focus();
    runFoodSearch("");
  }

  if (tab === "custom") {
    renderCustomTab(body);
  }

  if (tab === "barcode") {
    body.innerHTML = `
      <label class="field">Штрихкод (введите вручную или отсканируйте)<input id="barcodeInput" inputmode="numeric" placeholder="Например: 4690228013307" autocomplete="off"></label>
      <div class="btn-row">
        <button data-action="lookupBarcode">Найти продукт</button>
        <button class="ghost" data-action="startScan">Сканировать камерой</button>
      </div>
      <div id="scanArea" style="margin-top:12px"></div>
      <div id="barcodeResult"></div>
      <div class="hint">База Open Food Facts: миллионы упакованных продуктов. Если продукт не найден — добавьте его вручную во вкладке «Поиск».</div>`;
    $("#barcodeInput").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); doBarcodeLookup($("#barcodeInput").value.trim()); } });
  }

  if (tab === "photo") {
    body.innerHTML = `
      <div class="empty" style="padding:24px 0;text-align:center">
        <div style="font-size:34px;margin-bottom:8px">📷</div>
        <div style="font-size:16px;font-weight:600;margin-bottom:6px">Не реализовано</div>
        <div class="hint" style="margin:0">Распознавание еды по фото пока не работает. Добавляйте еду через поиск, голос или вручную.</div>
      </div>`;
  }
}

function localFoodResults(q) {
  const norm = q.toLowerCase().replace(/ё/g, "е");
  if (!norm) return FOOD_DB.slice(0, 30);
  return FOOD_DB.filter(x => {
    const n = x.name.toLowerCase().replace(/ё/g, "е");
    return n.includes(norm) || norm.includes(n);
  }).slice(0, 40);
}

async function runFoodSearch(q) {
  const local = localFoodResults(q);
  const custom = q ? data.customFoods.filter(x => x.name.toLowerCase().includes(q.toLowerCase())) : data.customFoods;
  const smart = q ? smartFoodQuery(q) : null;
  const res = $("#foodResults");
  const smartRow = smart ? `
    <div class="result-item" data-action="pickFood" data-grams="${smart.grams}" data-json="${esc(JSON.stringify({ name: smart.item.name, cal: smart.item.cal, p: smart.item.p, f: smart.item.f, c: smart.item.c, piece: smart.item.piece || null }))}">
      <div class="ri-main"><div class="ri-name">${esc(smart.item.name)}<span class="badge custom">быстрый ввод</span></div>
      <div class="ri-sub">${Math.round(num(smart.item.cal) * smart.grams / 100)} ккал за ${smart.grams} г · Б ${fmtNum(num(smart.item.p) * smart.grams / 100)} · Ж ${fmtNum(num(smart.item.f) * smart.grams / 100)} · У ${fmtNum(num(smart.item.c) * smart.grams / 100)}</div></div>
      <span class="ri-kcal">→</span></div>` : "";
  const renderRows = (offItems, offlineNote) => `
    ${smartRow}
    ${custom.length ? custom.map(c => resultRow({ name: c.name, cal: c.cal, p: c.p, f: c.f, c: c.c, source: "custom", id: c.id })).join("") : ""}
    ${local.map(x => resultRow({ name: x.name, cal: x.cal, p: x.p, f: x.f, c: x.c, source: "db", piece: x.piece })).join("")}
    ${offItems.map(x => resultRow(x)).join("")}
    ${offlineNote ? `<div class="hint">${offlineNote}</div>` : ""}`;

  if (!q) { res.innerHTML = renderRows([]); return; }

  res.innerHTML = renderRows([], `<div id="offLoading">Ищем в Open Food Facts…</div>`);
  if (!navigator.onLine) {
    res.innerHTML = renderRows([], "Нет интернета — показаны только встроенные продукты.");
    return;
  }
  try {
    const off = await offSearch(q);
    const el = $("#offLoading"); if (el) el.remove();
    res.insertAdjacentHTML("beforeend", off.map(x => resultRow(x)).join(""));
    if (!off.length) res.insertAdjacentHTML("beforeend", `<div class="hint">В Open Food Facts ничего не нашлось.</div>`);
  } catch {
    const el = $("#offLoading"); if (el) el.remove();
    res.insertAdjacentHTML("beforeend", `<div class="hint">Open Food Facts недоступен (нет сети?).</div>`);
  }
}

function resultRow(x) {
  const md = v => v == null ? "н/д" : fmtNum(v);
  const sub = `${Math.round(num(x.cal))} ккал/100г · Б${md(x.p)} Ж${md(x.f)} У${md(x.c)}`;
  const badge = x.source === "off" ? `<span class="badge off">база OFF</span>` : x.source === "custom" ? `<span class="badge custom">моё</span>` : "";
  return `<div class="result-item" data-action="pickFood" data-json="${esc(JSON.stringify({ name: x.name, cal: x.cal, p: x.p, f: x.f, c: x.c, piece: x.piece || null }))}">
    <div class="ri-main"><div class="ri-name">${esc(x.name)}${badge}</div><div class="ri-sub">${sub}</div></div>
    <span class="ri-kcal">→</span></div>`;
}

function openPortionEditor(item, presetGrams) {
  const names = data.settings.mealNames.length ? data.settings.mealNames : ["Завтрак", "Обед", "Ужин", "Перекус"];
  const mealSel = names.map(n => `<option${n === foodSearchCtx.meal ? " selected" : ""}>${esc(n)}</option>`).join("");
  const chips = [50, 100, 150, 200, 300].map(g => `<button data-grams="${g}">${g} г</button>`).join("");
  const pieceChips = item.piece ? [1, 2, 3].map(n => `<button data-grams="${item.piece * n}">${n} шт (${item.piece * n} г)</button>`).join("") : "";
  const portionChip = item.piece ? "" : `<button data-grams="250">порция ≈ 250 г</button>`;
  openModal(`
    <div class="modal-head"><h3>${esc(item.name)}</h3><button class="close-x" data-action="backToSearch">✕</button></div>
    <div class="hint" style="margin:0 0 6px">На 100 г: ${Math.round(num(item.cal))} ккал · Б ${item.p == null ? "н/д" : fmtNum(item.p)} · Ж ${item.f == null ? "н/д" : fmtNum(item.f)} · У ${item.c == null ? "н/д" : fmtNum(item.c)}</div>
    <label class="field">Сколько грамм (или порций в граммах)<input type="number" id="portionGrams" value="${presetGrams || 100}" min="1" step="1"></label>
    <div class="chips">${chips}${pieceChips}${portionChip}</div>
    <div class="macro-grid">
      <div class="card"><span>Ккал</span><strong id="pvCal">—</strong></div>
      <div class="card"><span>Белки</span><strong id="pvP">—</strong></div>
      <div class="card"><span>Жиры</span><strong id="pvF">—</strong></div>
      <div class="card"><span>Углеводы</span><strong id="pvC">—</strong></div>
    </div>
    <label class="field">Приём пищи<select id="portionMeal">${mealSel}</select></label>
    <div class="btn-row"><button data-action="confirmPortion" data-item="${esc(JSON.stringify(item))}">Добавить в дневник</button></div>
  `, { center: true });

  const upd = () => {
    const g = num($("#portionGrams").value) || 0;
    const k = g / 100;
    $("#pvCal").textContent = Math.round(num(item.cal) * k);
    $("#pvP").textContent = fmtNum(num(item.p) * k) + " г";
    $("#pvF").textContent = fmtNum(num(item.f) * k) + " г";
    $("#pvC").textContent = fmtNum(num(item.c) * k) + " г";
  };
  $("#portionGrams").addEventListener("input", upd);
  $$(".chips button").forEach(b => b.addEventListener("click", () => { $("#portionGrams").value = b.dataset.grams; upd(); }));
  upd();
}

function confirmPortion(item) {
  const grams = num($("#portionGrams").value);
  if (!grams) { toast("Укажите граммы", true); return; }
  const meal = $("#portionMeal").value;
  const k = grams / 100;
  const entry = touch({
    id: uid(), date: selectedDate, meal, name: item.name,
    grams, cal: Math.round(num(item.cal) * k), p: +num(item.p) * k, f: +num(item.f) * k, c: +num(item.c) * k
  });
  entry.p = Math.round(entry.p * 10) / 10; entry.f = Math.round(entry.f * 10) / 10; entry.c = Math.round(entry.c * 10) / 10;
  if (foodSearchCtx.target === "plan") {
    (data.mealPlan[selectedDate] = data.mealPlan[selectedDate] || []).push(entry);
    toast("Добавлено в план питания");
  } else {
    data.foods.push(entry);
    toast(`Добавлено: ${item.name} (${grams} г)`);
  }
  closeModal();
  refresh();
}

function renderCustomTab(body) {
  body.innerHTML = `
    <p class="hint" style="margin:0 0 10px">Свои блюда и рецепты: сохраните КБЖУ на 100 г один раз — потом ищите и добавляйте в один тап. «Из ингредиентов» собирает блюдо целиком (например, пиццу) и считает КБЖУ всей пиццы и на 100 г.</p>
    <div class="btn-row" style="margin-top:0">
      <button class="ghost" data-action="newCustomFood">＋ Новое блюдо</button>
      <button class="ghost" data-action="newRecipe">Из ингредиентов</button>
    </div>
    <div id="customList"></div>`;
  renderCustomList();
}

function renderCustomList() {
  const el = $("#customList");
  if (!el) return;
  el.innerHTML = data.customFoods.length ? data.customFoods.map(c => `
    <div class="result-item" data-action="pickFood" data-json="${esc(JSON.stringify({ name: c.name, cal: c.cal, p: c.p, f: c.f, c: c.c }))}">
      <div class="ri-main"><div class="ri-name">${esc(c.name)}<span class="badge custom">моё</span>${c.recipe ? `<span class="badge">рецепт</span>` : ""}</div>
      <div class="ri-sub">${Math.round(num(c.cal))} ккал/100г · Б${fmtNum(c.p)} Ж${fmtNum(c.f)} У${fmtNum(c.c)}${c.recipe ? ` · всего ${c.recipe.finishedGrams} г` : ""}</div></div>
      <div class="ri-actions">
        ${c.recipe ? `<button class="small ghost" data-action="editRecipe" data-id="${c.id}">Рецепт</button>` : `<button class="small ghost" data-action="editCustomFood" data-id="${c.id}">КБЖУ</button>`}
        <button class="small danger" data-action="delCustomFood" data-id="${c.id}">Удалить</button>
        <span class="ri-kcal">→</span>
      </div>
    </div>`).join("") : `<div class="empty">Пока нет своих блюд.</div>`;
}

function newCustomFood(existing) {
  openModal(`
    <div class="modal-head"><h3>${existing ? "Изменить блюдо" : "Новое блюдо"}</h3><button class="close-x" data-action="closeModal">✕</button></div>
    <label class="field">Название<input id="cfName" value="${esc(existing ? existing.name : "")}" placeholder="Например: бабушкин борщ"></label>
    <div class="field-grid-3">
      <label class="field">Белки<input id="cfP" type="number" min="0" step="0.1" value="${existing ? existing.p : ""}"></label>
      <label class="field">Жиры<input id="cfF" type="number" min="0" step="0.1" value="${existing ? existing.f : ""}"></label>
      <label class="field">Углеводы<input id="cfC" type="number" min="0" step="0.1" value="${existing ? existing.c : ""}"></label>
      <label class="field">Ккал/100г<input id="cfCal" type="number" min="0" step="1" value="${existing ? existing.cal : ""}"></label>
    </div>
    <label class="autocal-chk"><input type="checkbox" id="cfAutoCal" ${existing && num(existing.cal) && num(existing.cal) !== macroCal(existing.p, existing.f, existing.c) ? "" : "checked"}> Считать калории по БЖУ (4·Б + 4·У + 9·Ж)</label>
    <div class="btn-row"><button data-action="saveCustomFood" data-id="${existing ? existing.id : ""}">Сохранить</button></div>
  `, { center: true });
  bindAutoCal("cfCal", "cfP", "cfF", "cfC", "cfAutoCal");
}

// автоподсчёт калорий по БЖУ в модалке
function bindAutoCal(calId, pId, fId, cId, chkId) {
  const cal = $("#" + calId), chk = $("#" + chkId);
  const recalc = () => { if (!chk || chk.checked) cal.value = macroCal($("#" + pId).value, $("#" + fId).value, $("#" + cId).value); };
  [pId, fId, cId].forEach(id => $("#" + id).addEventListener("input", recalc));
  if (chk) {
    chk.addEventListener("change", () => { cal.readOnly = chk.checked; recalc(); if (!chk.checked) cal.focus(); });
    cal.readOnly = chk.checked;
  }
}

function saveCustomFood(id) {
  const name = $("#cfName").value.trim();
  if (!name) { toast("Укажите название", true); return; }
  const cf = touch({ id: id || uid(), name, cal: num($("#cfCal").value), p: num($("#cfP").value), f: num($("#cfF").value), c: num($("#cfC").value) });
  if (id) data.customFoods = data.customFoods.map(x => x.id === id ? cf : x);
  else data.customFoods.push(cf);
  closeModal();
  refresh();
  renderFoodSearch("custom");
  toast("Блюдо сохранено");
}

/* ---------- Экспорт в CSV (Excel) ---------- */
// Разделитель «;» и запятая в числах — русская локаль Excel. Одна таблица с колонкой «тип».
function csvCell(v) { return '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"'; }
function numRu(v) { const n = Number(v); return Number.isFinite(n) ? String(n).replace(".", ",") : ""; }
/* ---------- Экспорт в .xlsx (SheetJS) — 4 листа ---------- */
function buildXlsxSheets(d) {
  const days = new Set();
  d.foods.forEach(f => days.add(f.date));
  d.weights.forEach(w => days.add(w.date));
  d.workouts.forEach(w => days.add(w.date));
  const sorted = [...days].sort();
  const foodRows = [["Дата", "Приём", "Название", "Граммы", "Ккал", "Белки", "Жиры", "Углеводы"]];
  const woutRows = [["Дата", "Название", "Подходы", "Мин", "Ккал", "Разгрузка"]];
  const wRows = [["Дата", "Вес, кг"]];
  for (const day of sorted) {
    const foods = d.foods.filter(f => f.date === day).sort((a, b) => (a.meal || "").localeCompare(b.meal || ""));
    foods.forEach(f => foodRows.push([day, f.meal || "", f.name || "", f.grams || "", round1(f.cal), round1(f.p), round1(f.f), round1(f.c)]));
    if (foods.length) foodRows.push(["", "ИТОГО", "", "", Math.round(sum(foods, "cal")), round1(sum(foods, "p")), round1(sum(foods, "f")), round1(sum(foods, "c"))]);
    d.weights.filter(w => w.date === day).forEach(w => wRows.push([day, w.kg]));
    d.workouts.filter(w => w.date === day).forEach(w => woutRows.push([day, w.name, (workoutExercises(w).map(e => e.name + ": " + setsLine(e.sets)).join(" | ")) || w.details || "", w.minutes || 0, w.cal || 0, w.deload ? "да" : ""]));
  }
  // лист «Прогресс»: динамика каждого упражнения
  const progRows = [["Упражнение", "Лучший подход", "Вес, кг", "Повторы", "Дата", "1ПМ сейчас", "1ПМ первый", "Рост 1ПМ, кг", "Раз, тренировался"]];
  const exCount = {};
  d.workouts.forEach(w => (workoutExercises(w) || []).forEach(e => { if (e.name && Array.isArray(e.sets) && e.sets.length) exCount[e.name] = (exCount[e.name] || 0) + 1; }));
  Object.keys(exCount).sort().forEach(name => {
    const hist = [];
    d.workouts.forEach(w => {
      workoutExercises(w).forEach(ex => {
        if (ex.name !== name || !ex.sets || !ex.sets.length) return;
        const best = ex.sets.reduce((b, s) => {
          const kg = num(s.weight), reps = parseFloat(String(s.reps || "").replace(",", ".")) || 0;
          return kg > b.kg ? { kg, reps } : b;
        }, { kg: 0, reps: 0 });
        if (best.kg) hist.push({ date: w.date, kg: best.kg, reps: best.reps });
      });
    });
    if (!hist.length) return;
    hist.sort((a, b) => a.date.localeCompare(b.date));
    const best = hist.reduce((b, p) => (p.kg > b.kg ? p : b), hist[0]);
    const last = hist[hist.length - 1];
    const e1last = e1rm(last.kg, last.reps), e1first = e1rm(hist[0].kg, hist[0].reps);
    const growth = e1last && e1first ? Math.round((e1last - e1first) * 10) / 10 : 0;
    progRows.push([name, `${best.kg} кг × ${best.reps}`, best.kg, best.reps, best.date, e1last || "", e1first || "", growth, exCount[name]]);
  });
  return { foodRows, woutRows, wRows, progRows };
}

function buildXlsHtml(d) {
  const days = new Set();
  d.foods.forEach(f => days.add(f.date));
  d.weights.forEach(w => days.add(w.date));
  d.workouts.forEach(w => days.add(w.date));
  const sorted = [...days].sort();
  const dbl = v => String(Math.round(v * 10) / 10).replace(".", ",");
  let rows = "";
  for (const day of sorted) {
    const foods = d.foods.filter(f => f.date === day).sort((a, b) => (a.meal || "").localeCompare(b.meal || ""));
    const weights = d.weights.filter(w => w.date === day);
    const workouts = d.workouts.filter(w => w.date === day);
    rows += `<tr style="background:#12233c"><td colspan="8" style="color:#7dd3fc;font-weight:bold">${day}${weights.length ? " · вес: " + weights.map(w => dbl(w.kg)).join(", ") + " кг" : ""}</td></tr>`;
    foods.forEach(f => rows += `<tr><td>${day}</td><td>${esc(f.meal || "")}</td><td>${esc(f.name || "")}</td><td>${f.grams ? dbl(f.grams) : ""}</td><td>${dbl(f.cal)}</td><td>${dbl(f.p)}</td><td>${dbl(f.f)}</td><td>${dbl(f.c)}</td></tr>`);
    if (foods.length) rows += `<tr style="background:#1a2f50"><td></td><td><b>ИТОГО</b></td><td></td><td></td><td style="font-weight:bold;color:#7dd3fc">${dbl(sum(foods, "cal"))}</td><td style="font-weight:bold;color:#7dd3fc">${dbl(sum(foods, "p"))}</td><td style="font-weight:bold;color:#7dd3fc">${dbl(sum(foods, "f"))}</td><td style="font-weight:bold;color:#7dd3fc">${dbl(sum(foods, "c"))}</td></tr>`;
    workouts.forEach(w => rows += `<tr><td>${day}</td><td>🏋️</td><td>${esc(w.name)}${w.deload ? " 💤" : ""}</td><td colspan="5" style="color:#9db8dc">${esc(workoutExercises(w).map(e => e.name + ": " + setsLine(e.sets)).join("  |  "))}</td></tr>`);
  }
  return "\uFEFF" + `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"><!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet><x:Name>Дневник</x:Name><x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions></x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]--></head><body><table border="1" cellpadding="4" cellspacing="0" style="border-collapse:collapse;font-family:Arial;font-size:11px;color:#dce8fa"><tr style="background:#0e2140;color:#7dd3fc"><th>Дата</th><th>Приём/тип</th><th>Название</th><th>Граммы</th><th>Ккал</th><th>Белки</th><th>Жиры</th><th>Углеводы</th></tr>${rows}</table></body></html>`;
}

function buildCsvRows(d) {
  const rows = [["тип", "дата", "приём/упражнение", "название", "граммы", "вес кг", "ккал", "белки", "жиры", "углеводы"].join(";"),];
  [...d.foods].sort((a, b) => a.date.localeCompare(b.date)).forEach(f =>
    rows.push(["еда", f.date, f.meal, f.name, numRu(f.grams), "", numRu(f.cal), numRu(f.p), numRu(f.f), numRu(f.c)].map(csvCell).join(";")));
  [...d.weights].sort((a, b) => a.date.localeCompare(b.date)).forEach(w =>
    rows.push(["вес", w.date, "", "", "", numRu(w.kg), "", "", "", ""].map(csvCell).join(";")));
  [...d.workouts].sort((a, b) => a.date.localeCompare(b.date) || (a.startedAt || 0) - (b.startedAt || 0)).forEach(w => {
    const ex = workoutExercises(w).map(e => `${e.name}: ${setsLine(e.sets) || "—"}`).join(" | ");
    rows.push(["тренировка", w.date, w.name, ex, "", "", numRu(w.cal), "", "", ""].map(csvCell).join(";"));
  });
  return rows.join("\r\n");
}

function saveMealAsDish(meal) {
  const items = foodsFor(selectedDate).filter(x => x.meal === meal);
  if (!items.length) return;
  const cal = sum(items, "cal"), p = sum(items, "p"), f = sum(items, "f"), c = sum(items, "c");
  const knownGrams = items.reduce((s, x) => s + num(x.grams), 0);
  const name = prompt("Название блюда:", `${meal} (${fmtDateShort(selectedDate)})`);
  if (!name) return;
  const grams = num(prompt("Общий вес готового блюда, г:", knownGrams ? String(Math.round(knownGrams)) : "300"));
  if (!grams) { toast("Без веса блюда нельзя посчитать КБЖУ на 100 г", true); return; }
  const k = 100 / grams;
  data.customFoods.push(touch({ id: uid(), name, cal: Math.round(cal * k), p: Math.round(p * k * 10) / 10, f: Math.round(f * k * 10) / 10, c: Math.round(c * k * 10) / 10 }));
  refresh();
  toast(`«${name}» сохранено в «Мои блюда»`);
}

/* ---------- Open Food Facts ---------- */
async function offSearch(q) {
  const url = `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(q)}&search_simple=1&action=process&json=1&page_size=20&fields=code,product_name,brands,nutriments`;
  const r = await fetch(url, { headers: { "Accept": "application/json" } });
  if (!r.ok) throw new Error("off");
  const j = await r.json();
  const out = [];
  (j.products || []).forEach(p => {
    const n = p.nutriments || {};
    const kcal = n["energy-kcal_100g"] != null ? n["energy-kcal_100g"] : (n.energy_100g ? n.energy_100g / 4.184 : null);
    if (!p.product_name || kcal == null) return;
    const name = p.brands ? `${p.product_name} (${String(p.brands).split(",")[0].trim()})` : p.product_name;
    const nz = v => v == null ? null : +v; // отсутствие данных — не ноль
    out.push({ name, cal: +kcal, p: nz(n.proteins_100g), f: nz(n.fat_100g), c: nz(n.carbohydrates_100g), source: "off" });
  });
  return out;
}

async function offBarcode(code) {
  const r = await fetch(`https://world.openfoodfacts.org/api/v0/product/${encodeURIComponent(code)}.json`);
  if (!r.ok) throw new Error("off");
  const j = await r.json();
  if (!j.product) return null;
  const p = j.product, n = p.nutriments || {};
  const kcal = n["energy-kcal_100g"] != null ? n["energy-kcal_100g"] : (n.energy_100g ? n.energy_100g / 4.184 : null);
  if (kcal == null) return null;
  const nz = v => v == null ? null : +v;
  return { name: p.product_name || code, cal: +kcal, p: nz(n.proteins_100g), f: nz(n.fat_100g), c: nz(n.carbohydrates_100g), source: "off" };
}

async function doBarcodeLookup(code) {
  if (!code) { toast("Введите штрихкод", true); return; }
  const out = $("#barcodeResult");
  out.innerHTML = `<div class="hint">Ищем ${esc(code)} в Open Food Facts…</div>`;
  try {
    const item = await offBarcode(code);
    if (!item) { out.innerHTML = `<div class="empty">Продукт не найден. Попробуйте найти по названию во вкладке «Поиск» или добавьте вручную.</div>`; return; }
    out.innerHTML = resultRow(item);
  } catch {
    out.innerHTML = `<div class="empty">Нет сети или сервис недоступен. Попробуйте позже или добавьте продукт вручную.</div>`;
  }
}

/* ---------- Сканер штрихкодов ---------- */
let barcodeStream = null, barcodeTimer = null;
function stopBarcodeScan() {
  if (barcodeTimer) { clearInterval(barcodeTimer); barcodeTimer = null; }
  if (barcodeStream) { barcodeStream.getTracks().forEach(t => t.stop()); barcodeStream = null; }
  const v = $("#barcodeVideo");
  if (v) v.srcObject = null;
}
async function startScan() {
  const area = $("#scanArea");
  if (!area) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    area.innerHTML = `<div class="empty">Камера недоступна в этом браузере. Введите штрихкод вручную.</div>`;
    return;
  }
  if (!("BarcodeDetector" in window)) {
    area.innerHTML = `<div class="empty">Автосканер не поддерживается этим браузером — наведите камеру в любом приложении-сканере и введите код вручную. (На Android в Chrome обычно работает.)</div>`;
    return;
  }
  try {
    barcodeStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    area.innerHTML = `<div class="scan-frame"><video id="barcodeVideo" autoplay playsinline muted></video><div class="scan-line"></div></div>`;
    const video = $("#barcodeVideo");
    video.srcObject = barcodeStream;
    const detector = new BarcodeDetector({ formats: ["ean_13", "ean_8", "upc_a", "upc_e", "code_128"] });
    barcodeTimer = setInterval(async () => {
      try {
        const codes = await detector.detect(video);
        if (codes.length) {
          stopBarcodeScan();
          area.innerHTML = "";
          $("#barcodeInput").value = codes[0].rawValue;
          doBarcodeLookup(codes[0].rawValue);
        }
      } catch { /* ignore */ }
    }, 700);
  } catch (e) {
    area.innerHTML = `<div class="empty">Не удалось получить доступ к камере. Введите код вручную.</div>`;
  }
}

/* ---------- Голос ---------- */
let recog = null, voiceItems = [];
function openVoice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  openModal(`
    <div class="modal-head"><h3>Голосовой ввод</h3><button class="close-x" data-action="closeModal">✕</button></div>
    ${SR ? `<div class="mic-big" data-action="toggleMic">🎤</div>
      <div class="voice-text" id="voiceText">Нажмите на микрофон и скажите, например:<br>«запиши на обед двести граммов гречки и куриную грудку»</div>
      <div id="voiceItems"></div>
      <div class="btn-row"><button data-action="addVoiceItems" disabled>Добавить в дневник</button></div>`
    : `<div class="empty">Голосовой ввод не поддерживается этим браузером. На Android попробуйте Chrome, на компьютере — Chrome или Edge. Можно пользоваться поиском и фото.</div>`}
  `);
  if (!SR) return;
  $("[data-action=toggleMic]").addEventListener("click", startVoiceRec);
}
function startVoiceRec() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (recog) { recog.stop(); recog = null; return; }
  recog = new SR();
  recog.lang = "ru-RU";
  recog.interimResults = true;
  recog.continuous = false;
  const mic = $("[data-action=toggleMic]");
  mic.classList.add("rec");
  $("#voiceText").textContent = "Слушаю…";
  recog.onresult = e => {
    let text = "";
    for (let i = e.resultIndex; i < e.results.length; i++) text += e.results[i][0].transcript;
    $("#voiceText").textContent = text;
    if (e.results[e.results.length - 1].isFinal) processVoice(text);
  };
  recog.onerror = e => {
    mic.classList.remove("rec");
    if (e.error === "not-allowed") $("#voiceText").textContent = "Нет доступа к микрофону. Разрешите его в настройках браузера.";
    else if (e.error !== "aborted") $("#voiceText").textContent = "Ошибка распознавания: " + e.error;
  };
  recog.onend = () => { mic.classList.remove("rec"); };
  recog.start();
}
function processVoice(text) {
  const parsed = parseMealText(text);
  voiceItems = parsed.items;
  renderVoiceItems();
}
function renderVoiceItems() {
  const el = $("#voiceItems");
  const btn = $("[data-action=addVoiceItems]");
  if (!voiceItems.length) { el.innerHTML = `<div class="empty">Ничего не распознано — попробуйте сказать ещё раз.</div>`; btn.disabled = true; return; }
  btn.disabled = false;
  el.innerHTML = voiceItems.map((it, i) => `
    <div class="result-item" style="cursor:default">
      <div class="ri-main">
        <div class="ri-name">${esc(it.name)}${it.matched ? `<span class="badge custom">найдено</span>` : `<span class="badge">не найдено</span>`}</div>
        <div class="field-grid-3" style="gap:6px;margin-top:6px">
          <input class="vi-g" data-i="${i}" type="number" value="${Math.round(it.grams)}" min="1" title="граммы">
          <input class="vi-cal" data-i="${i}" type="number" value="${Math.round(it.cal)}" min="0" title="ккал">
          <input class="vi-p" data-i="${i}" type="number" value="${it.p}" min="0" step="0.1" title="белки">
        </div>
        <div class="field-grid-3" style="gap:6px;margin-top:6px">
          <input class="vi-f" data-i="${i}" type="number" value="${it.f}" min="0" step="0.1" title="жиры">
          <input class="vi-c" data-i="${i}" type="number" value="${it.c}" min="0" step="0.1" title="углеводы">
        </div>
        ${it.matched ? "" : `<button class="small ghost" data-action="searchVoiceItem" data-i="${i}" style="margin-top:6px">Найти в базе по названию</button>`}
      </div>
    </div>`).join("");
}
function searchVoiceItem(i) {
  const it = voiceItems[i];
  foodSearchCtx.meal = it.meal || foodSearchCtx.meal;
  closeModal();
  openFoodSearch(foodSearchCtx.meal);
  setTimeout(() => { const inp = $("#foodQuery"); if (inp) { inp.value = it.name; inp.dispatchEvent(new Event("input")); } }, 60);
}
function addVoiceItems() {
  const parsedMeal = parseMealText($("#voiceText").textContent || "").meal;
  const meal = parsedMeal || foodSearchCtx.meal;
  let added = 0, skipped = 0;
  voiceItems.forEach((it, i) => {
    const cal = num($(`.vi-cal[data-i="${i}"]`).value);
    if (!cal && !it.matched) { skipped++; return; } // нераспознанное без калорий не сохраняем
    const rec = touch({
      id: uid(), date: selectedDate, meal: it.meal || meal,
      name: it.name, grams: num($(`.vi-g[data-i="${i}"]`).value),
      cal, p: num($(`.vi-p[data-i="${i}"]`).value),
      f: num($(`.vi-f[data-i="${i}"]`).value), c: num($(`.vi-c[data-i="${i}"]`).value)
    });
    if (foodSearchCtx.target === "plan") (data.mealPlan[selectedDate] = data.mealPlan[selectedDate] || []).push(rec);
    else data.foods.push(rec);
    added++;
  });
  closeModal();
  refresh();
  if (skipped) toast(`Пропущено ${skipped}: найдите блюдо в базе (кнопка «Найти в базе»)`, true);
  toast(`Добавлено позиций: ${added}`);
}

/* Парсер фразы: «на обед два яйца и 200 грамм гречки» */
function canonicalMeal(word) {
  if (!word) return null;
  const w = word.toLowerCase().replace(/ё/g, "е");
  const names = data.settings.mealNames.length ? data.settings.mealNames : ["Завтрак", "Обед", "Ужин", "Перекус"];
  return names.find(n => n.toLowerCase().replace(/ё/g, "е").includes(w)) || null;
}
function parseMealText(text) {
  const t = " " + text.toLowerCase().replace(/ё/g, "е") + " ";
  const mealMatch = t.match(/второй завтрак|завтрак|обед|ужин|перекус|полдник/);
  const meal = mealMatch ? canonicalMeal(mealMatch[0]) : null;
  const chunks = text.split(/[,;]|\s+и\s+|\s+плюс\s+/).map(s => s.trim()).filter(Boolean);
  const items = chunks.map(chunk => parseChunk(chunk)).filter(Boolean);
  return { meal, items };
}
function parseChunk(chunk) {
  let s = " " + chunk.toLowerCase().replace(/ё/g, "е") + " ";
  s = s.replace(/\s(бро|братан|съел|съела|выпил|выпила|положи|запиши|добавь|мне|было|это|пожалуйста|еще|ещё)\s/g, " ");
  s = s.replace(/\sбез\s+сахара\s/g, " ").replace(/\sбез\s+соли\s/g, " ");
  if (/полкило/.test(s)) { s = s.replace(/полкило/, ""); return parseChunkCore(s, 500, "g"); }
  s = s.replace(/\s*(завтрак\w*|обед\w*|ужин\w*|перекус\w*|полдник\w*)\s*/g, " ");
  // число
  let qty = null;
  const digit = s.match(/(\d+(?:[.,]\d+)?)/);
  if (digit) qty = parseFloat(digit[1].replace(",", "."));
  else {
    for (const [w, v] of Object.entries(NUM_WORDS)) {
      if (new RegExp("\\s" + w + "\\s").test(s)) { qty = v; s = s.replace(new RegExp("\\s" + w + "\\s"), " "); break; }
    }
    if (qty == null && /пара\s/.test(s)) { qty = 2; s = s.replace(/\sпара\s/, " "); }
  }
  return parseChunkCore(s, qty, null);
}
function parseChunkCore(s, qty, unit) {
  // единицы
  let unit_ = unit, mult = 1;
  const unitMap = [
    [/кг|килограмм\w*/, "kg"], [/грамм\w*|гр\b|\sг\s/, "g"], [/мл|миллилитр\w*/, "ml"],
    [/литр\w*|\sл\s/, "l"], [/штук\w*|шт\b|штука|штуки/, "pc"], [/порци\w*/, "portion"],
    [/стакан\w*/, "cup"], [/чашк\w*/, "cup"], [/столов\w*\s*ложк\w*/, "tbsp"], [/чайн\w*\s*ложк\w*/, "tsp"], [/ложк\w*/, "tbsp"],
    [/ломтик\w*|кусоч\w*|кусок/, "slice"]
  ];
  for (const [re, u] of unitMap) {
    const m = s.match(re);
    if (m) { unit_ = u; s = s.replace(m[0], " "); break; }
  }
  // имя
  let name = s.replace(/\d+([.,]\d+)?/g, " ").replace(/\s+/g, " ").trim();
  name = name.replace(/^(на|в|это|было)\s+/, "").trim();
  // поиск в базе
  const matched = findFoodMatch(name);
  let grams = 100, cal = 0, p = 0, f = 0, c = 0;
  if (matched) {
    if (unit_ === "kg") grams = (qty || 0.1) * 1000;
    else if (unit_ === "g" || unit_ === "ml") grams = qty || 100;
    else if (unit_ === "l") grams = (qty || 0.25) * 1000;
    else if (unit_ === "cup") grams = (qty || 1) * 250;
    else if (unit_ === "tbsp") grams = (qty || 1) * 25;
    else if (unit_ === "tsp") grams = (qty || 1) * 10;
    else if (unit_ === "slice") grams = (qty || 1) * 30;
    else if (unit_ === "portion") grams = (qty || 1) * 250;
    else if (unit_ === "pc") grams = matched.piece ? (qty || 1) * matched.piece : (qty || 1) * 100;
    else grams = qty != null && matched.piece ? qty * matched.piece : (qty != null ? qty * 100 : 100);
    const k = grams / 100;
    cal = Math.round(matched.cal * k); p = Math.round(matched.p * k * 10) / 10;
    f = Math.round(matched.f * k * 10) / 10; c = Math.round(matched.c * k * 10) / 10;
    return { name: matched.name, raw: name, grams, cal, p, f, c, matched: true, meal: null };
  }
  if (!name.trim()) return null; // пустой обрывок фразы
  return { name: name || chunk, raw: name, grams: qty ? qty * 100 : 100, cal: 0, p: 0, f: 0, c: 0, matched: false, meal: null };
}
function findFoodMatch(name) {
  if (!name) return null;
  const nq = name.toLowerCase().replace(/ё/g, "е").trim();
  if (!nq) return null;
  let best = null, bestScore = 0;
  const all = FOOD_DB.concat(data.customFoods.map(c => ({ name: c.name, cal: c.cal, p: c.p, f: c.f, c: c.c, piece: null })));
  for (const item of all) {
    const iname = item.name.toLowerCase().replace(/ё/g, "е");
    let score = 0;
    if (iname === nq) score = 100;
    else if (iname.includes(nq) || nq.includes(iname)) score = 80 - Math.abs(iname.length - nq.length) * 0.5;
    else {
      const toks = nq.split(/\s+/).filter(w => w.length > 3);
      const itoks = iname.split(/\s+/);
      const hit = toks.filter(w => itoks.some(iw => {
        const stem = w.slice(0, Math.max(3, w.length - 1));
        return iw.startsWith(w) || iw.startsWith(stem);
      })).length;
      if (toks.length && hit / toks.length >= 0.5) score = 40 * hit / toks.length;
    }
    if (score > bestScore) { bestScore = score; best = item; }
  }
  return bestScore >= 25 ? best : null;
}

// «гречка 150» — название + граммы одной строкой: сразу открывает порцию
function smartFoodQuery(q) {
  const m = String(q || "").trim().match(/^(.*?)\s+(\d+(?:[.,]\d+)?)\s*(?:гр?|грамм(?:ов)?)?$/i);
  if (!m || !m[1].trim()) return null;
  const grams = Math.round(parseFloat(m[2].replace(",", ".")));
  if (!(grams > 0)) return null;
  const item = findFoodMatch(m[1].trim());
  return item ? { item, grams } : null;
}

/* ---------- Ручное добавление (как в старой версии) ---------- */
function showAddManually() {
  const names = data.settings.mealNames.length ? data.settings.mealNames : ["Завтрак", "Обед", "Ужин", "Перекус"];
  openModal(`
    <div class="modal-head"><h3>Добавить вручную</h3><button class="close-x" data-action="closeModal">✕</button></div>
    <p class="hint" style="margin:0 0 10px">Знаете БЖУ — калории посчитаются сами: 1 г белка = 4 ккал, 1 г углеводов = 4 ккал, 1 г жиров = 9 ккал.</p>
    <label class="field">Название<input id="mfName" placeholder="Например: овсянка"></label>
    <div class="field-grid-3" style="margin-top:8px">
      <label class="field">Белки<input id="mfP" type="number" min="0" step="0.1"></label>
      <label class="field">Жиры<input id="mfF" type="number" min="0" step="0.1"></label>
      <label class="field">Углеводы<input id="mfC" type="number" min="0" step="0.1"></label>
      <label class="field">Ккал<input id="mfCal" type="number" min="0" step="1"></label>
      <label class="field">Граммы<input id="mfG" type="number" min="0" step="1"></label>
      <label class="field">Приём<select id="mfMeal">${names.map(n => `<option>${esc(n)}</option>`).join("")}</select></label>
    </div>
    <label class="autocal-chk"><input type="checkbox" id="mfAutoCal" checked> Считать калории по БЖУ (4·Б + 4·У + 9·Ж)</label>
    <div class="btn-row"><button data-action="saveManualFood">Добавить</button></div>
  `, { center: true });
  bindAutoCal("mfCal", "mfP", "mfF", "mfC", "mfAutoCal");
}
function saveManualFood() {
  const name = $("#mfName").value.trim();
  const cal = num($("#mfCal").value), p = num($("#mfP").value), f = num($("#mfF").value), c = num($("#mfC").value);
  if (!name && !cal && !p && !f && !c) { toast("Заполните хотя бы название или калории", true); return; }
  const rec = touch({ id: uid(), date: selectedDate, meal: $("#mfMeal").value, name: name || "Без названия", grams: num($("#mfG").value) || null, cal, p, f, c });
  if (foodSearchCtx.target === "plan") (data.mealPlan[selectedDate] = data.mealPlan[selectedDate] || []).push(rec);
  else data.foods.push(rec);
  closeModal();
  refresh();
}

function editFood(id) {
  const item = data.foods.find(x => x.id === id);
  if (!item) return;
  const names = data.settings.mealNames.length ? data.settings.mealNames : ["Завтрак", "Обед", "Ужин", "Перекус"];
  const auto = !num(item.cal) || num(item.cal) === macroCal(item.p, item.f, item.c);
  openModal(`
    <div class="modal-head"><h3>Изменить запись</h3><button class="close-x" data-action="closeModal">✕</button></div>
    <label class="field">Название<input id="efName" value="${esc(item.name)}"></label>
    <div class="field-grid-3" style="margin-top:8px">
      <label class="field">Белки<input id="efP" type="number" min="0" step="0.1" value="${item.p}"></label>
      <label class="field">Жиры<input id="efF" type="number" min="0" step="0.1" value="${item.f}"></label>
      <label class="field">Углеводы<input id="efC" type="number" min="0" step="0.1" value="${item.c}"></label>
      <label class="field">Ккал<input id="efCal" type="number" min="0" step="1" value="${item.cal}"></label>
      <label class="field">Граммы<input id="efG" type="number" min="0" step="1" value="${item.grams || ""}"></label>
      <label class="field">Приём<select id="efMeal">${names.map(n => `<option${n === item.meal ? " selected" : ""}>${esc(n)}</option>`).join("")}</select></label>
    </div>
    <label class="autocal-chk"><input type="checkbox" id="efAutoCal" ${auto ? "checked" : ""}> Считать калории по БЖУ (4·Б + 4·У + 9·Ж)</label>
    <div class="btn-row"><button data-action="saveEditFood" data-id="${id}">Сохранить</button></div>
  `, { center: true });
  bindAutoCal("efCal", "efP", "efF", "efC", "efAutoCal");
}
function saveEditFood(id) {
  const item = data.foods.find(x => x.id === id);
  if (!item) return;
  item.name = $("#efName").value.trim() || item.name;
  item.cal = num($("#efCal").value); item.p = num($("#efP").value); item.f = num($("#efF").value); item.c = num($("#efC").value);
  item.grams = num($("#efG").value) || null; item.meal = $("#efMeal").value;
  touch(item);
  closeModal(); refresh();
}

let mealHistory = []; // {date, items} — составы приёма пищи из прошлых дней

// «Повторить»: последние 6 составов этого приёма пищи из истории
function repeatMeal(meal) {
  const days = {};
  for (const f of data.foods) if (f.meal === meal && f.date !== selectedDate) (days[f.date] = days[f.date] || []).push(f);
  mealHistory = Object.entries(days).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 6);
  if (!mealHistory.length) { toast("Нет прошлых записей этого приёма", true); return; }
  openModal(`
    <div class="modal-head"><h3>Повторить: ${esc(meal)}</h3><button class="close-x" data-action="closeModal">✕</button></div>
    <p class="hint" style="margin:0 0 10px">Нажми — состав за этот день скопируется на выбранную дату.</p>
    ${mealHistory.map(([date, items]) => `
      <div class="result-item" style="cursor:default">
        <div class="ri-main"><div class="ri-name">${fmtDateRu(date)} · ${Math.round(sum(items, "cal"))} ккал</div>
        <div class="ri-sub">${items.map(i => esc(i.name) + (i.grams ? " " + i.grams + " г" : "")).join(" · ")}</div></div>
        <button class="small primary" data-action="copyMeal" data-date="${date}">Скопировать</button>
      </div>`).join("")}`);
}

function copyMeal(date) {
  const found = mealHistory.find(([d]) => d === date);
  if (!found) return;
  found[1].forEach(it => data.foods.push({ ...it, id: uid(), date: selectedDate }));
  closeModal();
  refresh();
  toast(`Скопировано: ${found[1].length} ${plural(found[1].length, "позиция", "позиции", "позиций")}`);
}

function copyYesterday() {
  const y = shiftDate(selectedDate, -1);
  const items = foodsFor(y);
  if (!items.length) { toast("За вчера ничего не записано", true); return; }
  if (!confirm(`Скопировать ${items.length} ${plural(items.length, "запись", "записи", "записей")} за ${fmtDateShort(y)} в ${fmtDateShort(selectedDate)}?`)) return;
  items.forEach(it => data.foods.push({ ...it, id: uid(), date: selectedDate }));
  refresh();
  toast("Скопировано");
}

/* ================= ТРЕНИРОВКИ ================= */
function renderWorkouts() {
  $("#dateInputW").value = selectedDate;
  const items = data.workouts.filter(w => w.date === selectedDate);
  $("#workoutList").innerHTML = items.length ? items.map(w => {
    const startedAt = w.startedAt ? new Date(w.startedAt) : null;
    const endTime = w.status === "done" && w.startedAt && w.minutes ? new Date(w.startedAt + w.minutes * 60000) : null;
    const startTimeStr = startedAt ? `${String(startedAt.getHours()).padStart(2,"0")}:${String(startedAt.getMinutes()).padStart(2,"0")}` : "";
    const endTimeStr = endTime ? `${String(endTime.getHours()).padStart(2,"0")}:${String(endTime.getMinutes()).padStart(2,"0")}` : "";
    const timeStr = (startTimeStr && endTimeStr) ? ` · ${startTimeStr}–${endTimeStr}` : (startTimeStr ? ` · с ${startTimeStr}` : "");
    return `
    <div class="item">
      <div class="item-main">
        <div class="name">${esc(w.name)} ${w.status === "in_progress" ? `<span class="badge">идёт</span>` : ""}${w.deload ? `<span class="badge">💤 разгрузка</span>` : ""}</div>
        <small>${w.minutes ? w.minutes + " мин" : ""}${w.minutes && w.cal ? " · " : ""}${w.cal ? w.cal + " ккал" : ""}${timeStr}</small>
        ${workoutBodyHtml(w)}
      </div>
      <div class="item-right">
        ${w.status === "in_progress" ? `<button class="small primary" data-action="resumeWorkout" data-id="${w.id}">Продолжить</button>` : ""}
        <button class="icon-btn" data-action="delWorkout" data-id="${w.id}">✕</button>
      </div>
    </div>`;
  }).join("") : `<div class="empty">Тренировок за этот день пока нет.</div>`;

  // планы
  $("#planList").innerHTML = data.plans.length ? data.plans.map(p => `
    <div class="panel" style="margin:12px 0 0;padding:14px">
      <div class="section-title" style="font-size:16px">${esc(p.name)}
        <span class="small-actions">
          <button class="small primary" data-action="startPlan" data-id="${p.id}">Начать тренировку</button>
          <button class="small ghost" data-action="editPlan" data-id="${p.id}">Изменить</button>
          <button class="small danger" data-action="delPlan" data-id="${p.id}">Удалить</button>
        </span>
      </div>
      ${p.exercises.map(e => `<div class="item" style="cursor:default"><div class="item-main"><div class="name" style="font-weight:600;font-size:14.5px">${esc(e.name)}</div><small>${e.sets} × ${esc(e.reps)}${e.weight ? " · " + esc(e.weight) : ""}</small></div></div>`).join("")}
    </div>`).join("") : emptyScene("Планов пока нет", "Создайте первый план — например «День ног»");

  // история тренировок (все записи)
  const hist = sortedWorkouts();
  $("#workoutHistory").innerHTML = hist.length ? hist.map(w => {
    const startedAt = w.startedAt ? new Date(w.startedAt) : null;
    const endTime = w.status === "done" && w.startedAt && w.minutes ? new Date(w.startedAt + w.minutes * 60000) : null;
    const startTimeStr = startedAt ? `${String(startedAt.getHours()).padStart(2,"0")}:${String(startedAt.getMinutes()).padStart(2,"0")}` : "";
    const endTimeStr = endTime ? `${String(endTime.getHours()).padStart(2,"0")}:${String(endTime.getMinutes()).padStart(2,"0")}` : "";
    const timeStr = (startTimeStr && endTimeStr) ? ` · ${startTimeStr}–${endTimeStr}` : (startTimeStr ? ` · с ${startTimeStr}` : "");
    return `
    <details class="workout-hist">
      <summary><b>${esc(w.name)}</b>${w.deload ? `<span class="badge">💤 разгрузка</span>` : ""}<span class="wh-meta">${fmtDateFullShort(w.date)}${timeStr}${w.minutes ? " · " + w.minutes + " мин" : ""}${w.cal ? " · " + w.cal + " ккал" : ""}${w.status === "in_progress" ? " · идёт" : ""}</span></summary>
      <div class="wh-body">${workoutBodyHtml(w) || `<div class="empty">Без деталей</div>`}</div>
    </details>`;
  }).join("") : emptyScene("История пуста", "Начните первую тренировку по плану — всё будет сюда записываться");
}

/* ---------- Тренировка вживую: запись подходов ---------- */
function openTrainingSession(planId) {
  const plan = data.plans.find(p => p.id === planId);
  if (!plan) return;
  let w = data.workouts.find(x => x.planId === planId && x.status === "in_progress");
  if (!w) {
    w = touch({ id: uid(), date: selectedDate, name: plan.name, planId, status: "in_progress", startedAt: Date.now(), minutes: 0, cal: 0, exercises: plan.exercises.map(e => ({ name: e.name, sets: [] })) });
    data.workouts.push(w);
    persist();
    renderWorkouts();
    toast("Тренировка началась — записывайте подходы по ходу занятия");
  } else {
    toast("Продолжаем незаконченную тренировку");
  }
  renderTrainingSession(w.id);
}

function renderTrainingSession(wid) {
  const w = data.workouts.find(x => x.id === wid);
  if (!w) return;
  const plan = data.plans.find(p => p.id === w.planId);
  const planEx = (plan && plan.exercises) || [];
  const exs = workoutExercises(w);
  // Нормализация суперсетов: сохраняем исходные ssGroup значения от плана,
  // но группируем смежные упражнения в группы для корректной работы таймера
  let groupCounter = 0;
  let pendingGroup = null;
  for (let i = 0; i < exs.length; i++) {
    if (exs[i].ssGroup) {
      if (!pendingGroup || pendingGroup.groupId !== exs[i].ssGroup) {
        // Новая группа суперсета
        groupCounter++;
        pendingGroup = { start: i, groupId: exs[i].ssGroup };
      } else {
        // Продолжаем текущую группу
      }
      // Определяем конец группы
      let end = i;
      for (let j = i + 1; j < exs.length && exs[j].ssGroup === exs[i].ssGroup; j++) {
        end = j;
      }
      // Помечаруем все упражнения группы
      for (let k = i; k <= end; k++) {
        exs[k].ssGroup = groupCounter;
        exs[k]._ssGroupIndex = groupCounter;
      }
      i = end; // пропускаем уже обработанные
    } else {
      pendingGroup = null;
    }
  }
  // Время тренировки
  const startedAt = w.startedAt ? new Date(w.startedAt) : null;
  const startTimeStr = startedAt ? `${String(startedAt.getHours()).padStart(2,"0")}:${String(startedAt.getMinutes()).padStart(2,"0")}` : "";
  // Сохраним нормализованные exs для restAfterSet (суперсеты)
  renderTrainingSession.wExs = exs;
  const rows = exs.map((ex, i) => {
    const last = lastSetsFor(ex.name, w);
    const planHint = planEx.find(pe => normExName(pe.name) === normExName(ex.name));
    const planTxt = planHint ? ` · план: ${planHint.sets}×${esc(planHint.reps)}${planHint.weight ? " · " + esc(planHint.weight) : ""}` : "";
    const pre = last && last.sets.length && ex.sets.length === 0 ? last.sets[last.sets.length - 1] : null;
    
    // Проверка: отключена ли рекомендация веса для этого упражнения
    const skipRecommend = data.settings.skipProgressHint && data.settings.skipProgressHint.includes(normExName(ex.name));
    
    // Двойная прогрессия: считаем сколько раз подряд выполнялись подходы по плану с одинаковым весом
    let progHint = "";
    let consecutivePlanHits = 0;
    let bestWeight = 0;
    
    if (!skipRecommend && last && last.sets.length && ex.sets.length === 0 && pre && pre.weight != null && pre.weight !== "") {
      const planReps = planHint ? parseInt(String(planHint.reps)) : 0;
      const setsN = last.sets.length;
      const doneN = last.sets.filter(s => {
        if (s.toFailure) return true;
        const r = parseFloat(String(s.reps || "").replace(",", ".")) || 0;
        return planReps ? r >= planReps : r > 0;
      }).length;
      
      // Считаем последовательные подходы, выполненные по плану
      const n = normExName(ex.name);
      const allWorkouts = data.workouts.filter(x => x.id !== w.id && x.date <= w.date).sort((a, b) => b.date.localeCompare(a.date) || (b.startedAt || 0) - (a.startedAt || 0));
      for (const pw of allWorkouts) {
        const exPrev = workoutExercises(pw).find(e => normExName(e.name) === n);
        if (!exPrev || !exPrev.sets.length) continue;
        const allDone = exPrev.sets.every(s => {
          if (s.toFailure) return true;
          const r = parseFloat(String(s.reps || "").replace(",", ".")) || 0;
          return planReps ? r >= planReps : r > 0;
        });
        if (allDone && setsN > 0) {
          consecutivePlanHits++;
          const wgt = num(exPrev.sets[0].weight);
          if (wgt > bestWeight) bestWeight = wgt;
        } else {
          break; // обрываем серию
        }
      }
      
      // Показываем рекомендацию только после 2+ выполненных подходов по плану
      if (doneN === setsN && consecutivePlanHits >= 2) {
        const recommendedWeight = Number(pre.weight) + 2.5;
        progHint = `<b style="color:var(--green)"> · выполнено ${setsN} из ${setsN} ${consecutivePlanHits} раз — попробуй ${fmtNum(recommendedWeight)} кг (+2,5)</b>`;
      } else if (doneN === setsN && consecutivePlanHits === 1) {
        progHint = `<b style="color:#888"> · выполнено ${setsN} из ${setsN} — повторим, потом предложу добавить вес</b>`;
      } else if (planReps) {
        progHint = `<b> · повторяем: ${doneN} из ${setsN} подходов по плану — вес пока тот же</b>`;
      }
    }
    return `
    <div class="ts-ex" draggable="true" data-ex-index="${i}">
      <div class="ts-ex-head"><b title="Перетащите для изменения порядка">⇅ ${esc(ex.name)}</b>${ex.ssGroup ? ` <span class="badge" title="Суперсет №${ex.ssGroup}: отдых только после последнего упражнения группы">⛓ ${ex.ssGroup}</span>` : ""}<span class="small-actions"><button class="small ghost" data-action="toggleSuperset" data-id="${w.id}" data-i="${i}" title="Убрать/добавить в суперсет (без отдыха между упражнениями группы)">⛓</button><button class="small ghost" data-action="toggleProgressHint" data-id="${w.id}" data-i="${i}" title="Отключить рекомендацию веса для этого упражнения">${(data.settings.skipProgressHint && data.settings.skipProgressHint.includes(normExName(ex.name))) ? '🔔' : '🔇'}</button><button class="icon-btn" data-action="delSessionEx" data-id="${w.id}" data-i="${i}" title="Удалить упражнение">✕</button></span></div>
      <div class="ts-last">${last ? `Прошлый раз (${fmtDateShort(last.date)}): <b>${esc(setsLine(last.sets))}</b>` : "Прошлый раз: записей нет"}${progHint}${planTxt}</div>
      <div class="ts-sets">${ex.sets.length ? ex.sets.map((s, j) => `<span class="set-chip">${esc(fmtSet(s))}<button class="edit-set" data-action="editSet" data-id="${w.id}" data-i="${i}" data-j="${j}" title="Редактировать подход">✎</button><button data-action="delSet" data-id="${w.id}" data-i="${i}" data-j="${j}" title="Удалить подход">✕</button></span>`).join("") : `<span class="empty" style="padding:4px 0">Подходы пока не записаны</span>`}</div>
      <div class="ts-input-row">
        <input class="ts-w" data-i="${i}" type="number" inputmode="numeric" min="0" step="0.5" placeholder="вес, кг" value="${pre && pre.weight != null ? pre.weight : ""}">
        <div style="display:flex;gap:6px;align-items:center;flex:1">
          <input class="ts-r" data-i="${i}" type="text" inputmode="numeric" placeholder="повторы" value="${pre ? esc(pre.reps) : ""}" style="flex:1">
          <label class="autocal-chk" style="white-space:nowrap;font-size:12px;margin:0"><input type="checkbox" class="chk-failure" data-i="${i}" ${pre && pre.toFailure ? "checked" : ""}> до отказа</label>
        </div>
        <button class="small ghost" data-action="repeatSet" data-id="${w.id}" data-i="${i}" title="Повторить прошлый подход">♻</button>
        <button class="small primary" data-action="addSet" data-id="${w.id}" data-i="${i}">Записать подход</button>
      </div>
      <input class="ts-note" data-i="${i}" placeholder="📝 заметка (напр. ломит запястье)" value="${esc(ex.note || "")}" style="margin-top:6px">
    </div>`;
  }).join("");
  openModal(`
    <div class="modal-head"><h3>${esc(w.name)} — запись подходов</h3><button class="close-x" data-action="closeSession">✕</button></div>
    <div class="hint" style="margin:0 0 10px">Вес и повторы вводятся по ходу тренировки. Всё сохраняется сразу — можно закрыть приложение и продолжить позже (кнопка «Продолжить» в списке тренировок за день).</div>
    <div id="tsList">${rows || `<div class="empty">В этом плане нет упражнений — добавьте их кнопкой ниже.</div>`}</div>
    <div class="hint" style="margin:0 0 8px">💡 Перетащите упражнение за ⇅ для изменения порядка · ⛓ суперсет — отдых только после последнего упражнения группы</div>
    <details class="timer-window">
      <summary>⏱ Таймер отдыха</summary>
      <div class="panel rest-panel" style="margin:0 0 12px;padding:12px">
        <div class="section-title" style="margin-bottom:8px">Таймер отдыха</div>
        <div class="rest-face"><b id="restTime">${restFmt(num(data.settings.restSec) || 90)}</b></div>
        <div class="field-grid" style="grid-template-columns:1fr 1fr;margin-top:8px">
          <label class="field">Сколько отдыхать
            <select id="restDur">
              ${[15,30,45,60,75,90,120,150,180,240,300].map(s => `<option value="${s}" ${+data.settings.restSec === s ? "selected" : ""}>${restFmt(s)}</option>`).join("")}
              <option value="custom">Свой интервал…</option>
            </select>
          </label>
          <label class="field">Свой, сек<input id="restCustom" type="number" min="5" max="3600" placeholder="Например: 100" style="display:none"></label>
        </div>
        <label class="autocal-chk" style="margin-top:8px"><input type="checkbox" id="restAuto" ${data.settings.restAuto ? "checked" : ""}> Запускать автоматически после записи подхода</label>
        <div class="btn-row" style="margin-top:10px">
          <button class="primary" data-action="restToggle" id="restToggleBtn">Старт</button>
          <button class="ghost" data-action="restReset">Сброс</button>
        </div>
      </div>
    </details>
    <div class="btn-row"><button class="ghost" data-action="addSessionEx" data-id="${w.id}">＋ Упражнение</button></div>
    <div class="field-grid" style="margin-top:10px">
      <label class="field">Длительность, мин<input id="tsMin" type="number" min="0" step="1" value="${w.minutes || ""}" placeholder="60"></label>
      <label class="field">Калории<input id="tsCal" type="number" min="0" step="1" value="${w.cal || ""}" placeholder="200"></label>
    </div>
    <div class="btn-row">
      <label class="autocal-chk" style="margin:0 12px 0 0"><input type="checkbox" id="tsDeload" ${w.deload ? "checked" : ""}> 💤 Разгрузочная неделя</label>
      <button data-action="finishWorkout" data-id="${w.id}">Завершить тренировку</button>
      <button class="ghost" data-action="closeSession">Закрыть (не удалять)</button>
    </div>
  `);
  // === Drag & Drop для перемещения упражнений ===
  let dragIdx = null;
  const list = $("#tsList");
  if (list) {
    list.querySelectorAll(".ts-ex").forEach(el => {
      el.addEventListener("dragstart", e => {
        dragIdx = +el.dataset.exIndex;
        el.style.opacity = "0.4";
        e.dataTransfer.effectAllowed = "move";
      });
      el.addEventListener("dragend", () => {
        el.style.opacity = "1";
        dragIdx = null;
        list.querySelectorAll(".ts-ex").forEach(x => x.style.borderTop = "");
      });
      el.addEventListener("dragover", e => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        el.style.borderTop = "2px solid var(--accent)";
      });
      el.addEventListener("dragleave", () => {
        el.style.borderTop = "";
      });
      el.addEventListener("drop", e => {
        e.preventDefault();
        el.style.borderTop = "";
        const dropIdx = +el.dataset.exIndex;
        if (dragIdx !== null && dragIdx !== dropIdx) {
          const exs = workoutExercises(w);
          const [moved] = exs.splice(dragIdx, 1);
          exs.splice(dropIdx, 0, moved);
          w.exercises = exs;
          touch(w);
          persist();
          renderTrainingSession(w.id);
        }
      });
    });
  }
  restDraw();
  $("#restDur").addEventListener("change", e => {
    const custom = $("#restCustom");
    if (custom) custom.style.display = e.target.value === "custom" ? "" : "none";
    if (e.target.value !== "custom") { data.settings.restSec = +e.target.value || 90; persist(); restReset(); }
  });
  $("#restCustom").addEventListener("change", e => {
    const sec = Math.min(3600, Math.max(5, Math.round(num(e.target.value) || 0)));
    if (sec) { data.settings.restSec = sec; persist(); restReset(); }
  });
  $("#restAuto").addEventListener("change", e => { data.settings.restAuto = !!e.target.checked; persist(); });
  $(".modal").addEventListener("keydown", e => {
    if (e.key === "Enter" && e.target.classList && e.target.classList.contains("ts-r")) {
      e.preventDefault();
      addSetBtn(w.id, +e.target.dataset.i);
    }
  });
  // заметка к упражнению: сохраняется по завершении ввода
  $(".modal").addEventListener("change", e => {
    const t = e.target;
    if (t.classList && t.classList.contains("ts-note")) {
      const ex = w.exercises && w.exercises[+t.dataset.i];
      if (ex) { ex.note = t.value.trim(); touch(w); persist(); }
    }
  });
}

function addSetBtn(wid, i) {
  const w = data.workouts.find(x => x.id === wid);
  if (!w || !w.exercises || !w.exercises[i]) return;
  const reps = $(`.ts-r[data-i="${i}"]`).value.trim();
  const wRaw = $(`.ts-w[data-i="${i}"]`).value.trim();
  const toFailure = $(`.chk-failure[data-i="${i}"]`) ? !!$(`.chk-failure[data-i="${i}"]`).checked : false;
  if (!reps) { toast("Укажите повторы — без них подход не запишется", true); return; }
  const auto = $("#restAuto") ? $("#restAuto").checked : data.settings.restAuto;
  const sec = restReadSec();
  data.settings.restAuto = !!auto;
  data.settings.restSec = sec;
  w.exercises[i].sets.push({ weight: wRaw === "" ? null : num(wRaw), reps, toFailure: toFailure });
  touch(w);
  persist();
  renderTrainingSession(wid);
  // PR-детекция: подход побил прошлый максимум упражнения?
  const wgt = num(wRaw);
  const repsN = parseFloat(String(reps).replace(",", ".")) || 0;
  const pastBest = wgt ? bestSetFor(w.exercises[i].name, w.id) : null;
  let announced = false;
  if (pastBest && wgt && (wgt > pastBest.kg || (wgt === pastBest.kg && repsN > pastBest.reps))) {
    toast(`🔥 Новый рекорд «${w.exercises[i].name}»: ${fmtNum(wgt)} кг × ${reps} (было ${fmtNum(pastBest.kg)} кг)`);
    announced = true;
  }
  // суперсет: отдых запускается только после последнего упражнения группы
  const ssGroup = renderTrainingSession.wExs ? renderTrainingSession.wExs[i].ssGroup : undefined;
  const inGroup = ssGroup !== undefined;
  
  let isLastInGroup = false;
  if (inGroup && renderTrainingSession.wExs) {
    // Найти максимальный индекс среди упражнений с этим ssGroup
    const groupIndices = renderTrainingSession.wExs
      .map((ex, idx) => ex.ssGroup === ssGroup ? idx : -1)
      .filter(idx => idx >= 0);
    isLastInGroup = groupIndices.length > 0 && i === Math.max(...groupIndices);
  }

  if (!announced && inGroup && !isLastInGroup) toast("Суперсет: следующий подход без отдыха ⛓");
  if (auto && (isLastInGroup || !inGroup)) restStart(sec);
}

function finishWorkout(wid) {
  const w = data.workouts.find(x => x.id === wid);
  if (!w) return;
  restReset();
  const totalSets = workoutExercises(w).reduce((s, e) => s + (e.sets || []).length, 0);
  w.minutes = num($("#tsMin").value);
  w.cal = num($("#tsCal").value);
  w.deload = !!($("#tsDeload") && $("#tsDeload").checked);
  w.status = "done";
  touch(w);
  persist();
  closeModal();
  refresh();
  toast(totalSets ? `Тренировка сохранена — ${totalSets} ${plural(totalSets, "подход", "подхода", "подходов")}` : "Тренировка сохранена");
}

// Подсказки упражнений в редакторе плана: группа по названию плана («день груди») или вручную
function renderExHints(ex, renderRows) {
  const el = $("#exHints");
  const planInput = $("#planName");
  if (!el || !planInput) return;
  const KEYWORDS = [
    [/груд/, "Грудь"], [/спин/, "Спина"], [/ног|присед|ягодиц/, "Ноги"], [/плеч/, "Плечи"],
    [/бицеп/, "Бицепс"], [/трицеп/, "Трицепс"], [/пресс|кор|живот/, "Пресс"]
  ];
  const autoGroup = () => {
    const n = planInput.value.toLowerCase().replace(/ё/g, "е");
    for (const [re, g] of KEYWORDS) if (re.test(n)) return g;
    return null;
  };
  let openGroup = autoGroup() || "Грудь";
  const draw = () => {
    const auto = autoGroup();
    if (auto) openGroup = auto;
    const group = EXERCISE_GROUPS.find(g => g.name === openGroup);
    el.innerHTML = `
      <div class="hint" style="margin:0 0 6px">Подсказки упражнений${auto ? ` — план на «${auto}»` : ""}:</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px">${EXERCISE_GROUPS.map(g => `<button type="button" class="small ${g.name === openGroup ? "primary" : "ghost"}" data-eg="${g.name}">${g.name}</button>`).join("")}</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px">${(group ? group.exercises : []).map(name => `<button type="button" class="small ghost" data-exadd="${esc(name)}">＋ ${esc(name)}</button>`).join("")}</div>`;
  };
  draw();
  el.addEventListener("click", e => {
    const chip = e.target.closest("[data-eg]");
    if (chip) { openGroup = chip.dataset.eg; draw(); return; }
    const add = e.target.closest("[data-exadd]");
    if (add) { ex.push({ name: add.dataset.exadd, sets: 3, reps: "12", weight: "" }); renderRows(); }
  });
  planInput.addEventListener("input", draw);
}

function openPlanEditor(plan) {
  const ex = (plan && plan.exercises) || [{ name: "", sets: 3, reps: "12", weight: "" }];
  openModal(`
    <div class="modal-head"><h3>${plan ? "Изменить план" : "Новый тренировочный план"}</h3><button class="close-x" data-action="closeModal">✕</button></div>
    <label class="field">Название плана<input id="planName" value="${esc(plan ? plan.name : "")}" placeholder="Например: День спины" required></label>
    <div id="exHints" style="margin-top:10px"></div>
    <div class="hint" style="margin:10px 0 4px">💡 Перетащите упражнение за ⇅ для изменения порядка</div>
    <div id="exRows" style="margin-top:8px"></div>
    <div class="btn-row">
      <button class="ghost" data-action="addExRow">＋ Упражнение</button>
      <button data-action="savePlan" data-id="${plan ? plan.id : ""}">Сохранить план</button>
    </div>
  `);
  const renderRows = () => {
    $("#exRows").innerHTML = ex.map((e, i) => `
      <div class="ex-drag" draggable="true" data-ex-index="${i}">
        <div class="ex-drag-head"><b title="Перетащите для изменения порядка">⇅ Упражнение ${i + 1}</b></div>
        <div class="field-grid">
          <label class="field" style="grid-column:1/-1"><input class="ex-name" data-i="${i}" value="${esc(e.name)}" placeholder="Например: жим лёжа"></label>
          <label class="field">Подходы<input class="ex-sets" data-i="${i}" type="number" min="1" value="${e.sets}"></label>
          <label class="field">Повторы/время<input class="ex-reps" data-i="${i}" type="text" value="${esc(e.reps)}" placeholder="12"></label>
          <label class="field" style="grid-column:1/-1">Вес (необязательно)<input class="ex-weight" data-i="${i}" value="${esc(e.weight || "")}" placeholder="40 кг"></label>
        </div>
        <div style="margin-top:6px;display:flex;align-items:center;gap:6px">
          <label class="autocal-chk">
            <input type="checkbox" class="chk-ss" data-i="${i}" ${(e && e.ssGroup) ? "checked" : ""}>
            Суперсет с предыдущим
          </label>
        </div>
      </div>`).join("");
  };
  renderRows();
  renderExHints(ex, renderRows);
  // === Drag & Drop для перемещения упражнений (как в живой тренировке) ===
  let dragIdx = null;
  const rowsEl = $("#exRows");
  rowsEl.addEventListener("dragstart", e => {
    if (e.target.closest("input,label")) return; // не тащим с полей ввода
    const el = e.target.closest("[data-ex-index]");
    if (!el) return;
    dragIdx = +el.dataset.exIndex;
    el.style.opacity = "0.4";
    e.dataTransfer.effectAllowed = "move";
  });
  rowsEl.addEventListener("dragend", () => {
    dragIdx = null;
    rowsEl.querySelectorAll("[data-ex-index]").forEach(x => { x.style.opacity = ""; x.style.borderTop = ""; });
  });
  rowsEl.addEventListener("dragover", e => {
    const el = e.target.closest("[data-ex-index]");
    if (!el) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    el.style.borderTop = "2px solid var(--accent)";
  });
  rowsEl.addEventListener("dragleave", e => {
    const el = e.target.closest("[data-ex-index]");
    if (el) el.style.borderTop = "";
  });
  rowsEl.addEventListener("drop", e => {
    const el = e.target.closest("[data-ex-index]");
    if (!el) return;
    e.preventDefault();
    el.style.borderTop = "";
    const dropIdx = +el.dataset.exIndex;
    if (dragIdx !== null && dragIdx !== dropIdx) {
      const [moved] = ex.splice(dragIdx, 1);
      ex.splice(dropIdx, 0, moved);
      renderRows();
    }
  });
  $("[data-action=addExRow]").addEventListener("click", () => { ex.push({ name: "", sets: 3, reps: "12", weight: "" }); renderRows(); });
  $("#exRows").addEventListener("input", e => {
    const i = +e.target.dataset.i;
    if (e.target.classList.contains("ex-name")) ex[i].name = e.target.value;
    if (e.target.classList.contains("ex-sets")) ex[i].sets = e.target.value;
    if (e.target.classList.contains("ex-reps")) ex[i].reps = e.target.value;
    if (e.target.classList.contains("ex-weight")) ex[i].weight = e.target.value;
  });
  // Обработка чекбоксов суперсета
  rowsEl.addEventListener("change", e => {
    if (e.target.classList.contains("chk-ss")) {
      const i = +e.target.dataset.i;
      if (e.target.checked) {
        const prev = ex[i - 1];
        if (prev && prev.ssGroup) {
          ex[i].ssGroup = prev.ssGroup;
        } else {
          ex[i].ssGroup = 'ss-' + i;
        }
      } else {
        delete ex[i].ssGroup;
      }
    }
  });
  $(".modal").addEventListener("click", e => {
    if (e.target.closest("[data-action=savePlan]")) {
      const name = $("#planName").value.trim();
      if (!name) { toast("Укажите название", true); return; }
      const exercises = ex.map(x => ({ name: x.name, sets: num(x.sets) || 3, reps: x.reps || "", weight: x.weight || "", ssGroup: x.ssGroup || null })).filter(x => x.name);
      if (!exercises.length) { toast("Добавьте хотя бы одно упражнение", true); return; }
      const p = touch({ id: plan ? plan.id : uid(), name, exercises });
      if (plan) data.plans = data.plans.map(x => x.id === plan.id ? p : x);
      else data.plans.push(p);
      closeModal(); refresh(); toast("План сохранён");
    }
  }, { once: false });
}

/* ---------- Конструктор блюд из ингредиентов ---------- */
let recipeCtx = null; // {id, name, items:[{name,grams,cal,p,f,c}], finished}

function openRecipeBuilder(existing) {
  if (existing && existing.recipe) {
    recipeCtx = {
      id: existing.id, name: existing.name,
      items: JSON.parse(JSON.stringify(existing.recipe.items)).map(it => ({ ...it, autoCal: it.autoCal !== false })),
      finished: existing.recipe.finishedGrams || null,
      finishedTouched: existing.recipe.finishedAuto === true ? false : true // авто-вес сохраняем, если он был авто
    };
  } else {
    recipeCtx = { id: null, name: existing ? existing.name : "", items: [], finished: null, finishedTouched: false };
  }
  renderRecipeBuilder();
}

function recipeTotals() {
  const t = { g: 0, cal: 0, p: 0, f: 0, c: 0 };
  (recipeCtx.items || []).forEach(it => {
    const k = num(it.grams) / 100;
    t.g += num(it.grams); t.cal += num(it.cal) * k; t.p += num(it.p) * k; t.f += num(it.f) * k; t.c += num(it.c) * k;
  });
  return t;
}

function renderRecipeBuilder() {
  openModal(`
    <div class="modal-head"><h3>Блюдо из ингредиентов</h3><button class="close-x" data-action="closeModal">✕</button></div>
    <p class="hint" style="margin:0 0 10px">Соберите блюдо из ингредиентов с известным КБЖУ (например, пиццу): приложение посчитает КБЖУ всего блюда и на 100 г. Потом просто записывайте, сколько грамм съели.</p>
    <label class="field">Название блюда<input id="rbName" value="${esc(recipeCtx.name)}" placeholder="Например: пицца домашняя"></label>
    <div class="search-row" style="margin-top:10px"><input id="rbQuery" placeholder="Поиск ингредиента: мука, сыр…" autocomplete="off"><button data-action="recipeAddManual">Вручную</button></div>
    <div id="rbResults" style="margin-top:8px"></div>
    <div id="rbItems" style="margin-top:12px"></div>
    <div id="rbTotals"></div>
    <div class="btn-row"><button data-action="saveRecipe">Сохранить блюдо</button></div>
  `);
  const q = $("#rbQuery");
  let deb = null;
  q.addEventListener("input", () => { clearTimeout(deb); deb = setTimeout(() => renderRecipeSearch(q.value.trim()), 300); });
  renderRecipeSearch("");
  renderRecipeItems();
}

function renderRecipeSearch(q) {
  const el = $("#rbResults");
  if (!el) return;
  const norm = (q || "").toLowerCase().replace(/ё/g, "е");
  let list = FOOD_DB.map(x => ({ name: x.name, cal: x.cal, p: x.p, f: x.f, c: x.c }))
    .concat(data.customFoods.map(x => ({ name: x.name, cal: x.cal, p: x.p, f: x.f, c: x.c })));
  if (norm) list = list.filter(x => x.name.toLowerCase().replace(/ё/g, "е").includes(norm));
  el.innerHTML = list.slice(0, 8).map(x => `
    <div class="result-item" data-action="recipePick" data-json="${esc(JSON.stringify(x))}">
      <div class="ri-main"><div class="ri-name">${esc(x.name)}</div><div class="ri-sub">${Math.round(num(x.cal))} ккал/100г · Б${fmtNum(x.p)} Ж${fmtNum(x.f)} У${fmtNum(x.c)}</div></div>
      <span class="ri-kcal">＋</span>
    </div>`).join("") || `<div class="empty">Ничего не нашлось — добавьте ингредиент кнопкой «Вручную».</div>`;
}

function renderRecipeItems() {
  const el = $("#rbItems");
  if (!el) return;
  el.innerHTML = recipeCtx.items.length ? recipeCtx.items.map((it, i) => `
    <div class="rb-item">
      <div class="field-grid-3" style="gap:6px">
        <label class="field" style="grid-column:1/-1">Ингредиент ${i + 1}<input class="rb-n" data-i="${i}" value="${esc(it.name)}" placeholder="Название"></label>
        <label class="field">Граммы<input class="rb-g" data-i="${i}" type="number" min="1" step="1" value="${it.grams}"></label>
        <label class="field">Ккал/100г<input class="rb-cal" data-i="${i}" type="number" min="0" step="1" value="${it.cal}"></label>
        <label class="field">Б/100г<input class="rb-p" data-i="${i}" type="number" min="0" step="0.1" value="${it.p}"></label>
        <label class="field">Ж/100г<input class="rb-f" data-i="${i}" type="number" min="0" step="0.1" value="${it.f}"></label>
        <label class="field">У/100г<input class="rb-c" data-i="${i}" type="number" min="0" step="0.1" value="${it.c}"></label>
      </div>
      <button class="icon-btn" data-action="recipeDelItem" data-i="${i}" title="Удалить ингредиент">✕</button>
    </div>`).join("") : `<div class="empty">Ингредиенты пока не добавлены — найдите выше или нажмите «Вручную».</div>`;
  el.oninput = onRbInput;
  renderRecipeTotals();
}

function onRbInput(e) {
  const t = e.target;
  if (!t.dataset || t.dataset.i == null) return;
  const i = +t.dataset.i;
  const it = recipeCtx.items[i];
  if (!it) return;
  if (t.classList.contains("rb-n")) it.name = t.value;
  if (t.classList.contains("rb-g")) {
    it.grams = num(t.value);
    // авто-вес готового блюда следует за суммой ингредиентов, пока его не правили вручную
    if (!recipeCtx.finishedTouched) {
      const sum = Math.round(recipeTotals().g);
      recipeCtx.finished = sum;
      const f = $("#rbFinished");
      if (f) f.value = sum || "";
    }
  }
  if (t.classList.contains("rb-cal")) { it.cal = num(t.value); it.autoCal = false; } // ручной ввод калорий — приоритет
  if (t.classList.contains("rb-p")) it.p = num(t.value);
  if (t.classList.contains("rb-f")) it.f = num(t.value);
  if (t.classList.contains("rb-c")) it.c = num(t.value);
  // для ингредиентов без своих калорий (вручную добавленных) калории считаются по БЖУ
  if (it.autoCal && (t.classList.contains("rb-p") || t.classList.contains("rb-f") || t.classList.contains("rb-c"))) {
    it.cal = macroCal(it.p, it.f, it.c);
    const calEl = t.closest(".rb-item").querySelector(".rb-cal");
    if (calEl && calEl !== t) { calEl.value = it.cal; }
  }
  updateRecipeMath();
}

function renderRecipeTotals() {
  const el = $("#rbTotals");
  if (!el) return;
  const t = recipeTotals();
  const finVal = recipeCtx.finishedTouched ? (recipeCtx.finished || "") : (t.g ? Math.round(t.g) : "");
  el.innerHTML = `
    <div class="review-grid">
      <div class="card" id="rbSumG"><span>Ингредиенты</span><strong>—</strong></div>
      <div class="card" id="rbSumTotal"><span>КБЖУ всего блюда</span><strong>—</strong><small>—</small></div>
      <div class="card" id="rbPer100"><span>На 100 г</span><strong>—</strong><small>—</small></div>
    </div>
    <label class="field" style="margin-top:10px">Вес готового блюда, г (если при готовке вес меняется — впишите итоговый)<input id="rbFinished" type="number" min="1" step="1" value="${finVal}" placeholder="например: 450"></label>`;
  $("#rbFinished").addEventListener("input", () => {
    recipeCtx.finishedTouched = true;
    recipeCtx.finished = num($("#rbFinished").value) || null;
    updateRecipeMath();
  });
  updateRecipeMath();
}

function updateRecipeMath() {
  const gEl = $("#rbSumG"), totEl = $("#rbSumTotal"), pEl = $("#rbPer100");
  const t = recipeTotals();
  const fin = num($("#rbFinished") ? $("#rbFinished").value : 0) || t.g; // единый вес для превью и сохранения
  const k = fin ? 100 / fin : 0;
  if (gEl) gEl.innerHTML = `<span>Ингредиенты</span><strong>${Math.round(t.g)} г</strong>`;
  if (totEl) totEl.innerHTML = `<span>КБЖУ всего блюда</span><strong>${Math.round(t.cal)} ккал</strong><small>Б ${fmtNum(t.p)} · Ж ${fmtNum(t.f)} · У ${fmtNum(t.c)} г</small>`;
  if (pEl) pEl.innerHTML = `<span>На 100 г</span><strong>${Math.round(t.cal * k)} ккал</strong><small>Б ${fmtNum(t.p * k)} · Ж ${fmtNum(t.f * k)} · У ${fmtNum(t.c * k)} г</small>`;
}

function saveRecipe() {
  const name = $("#rbName").value.trim();
  if (!name) { toast("Укажите название блюда", true); return; }
  const items = recipeCtx.items.filter(it => it.name && it.name.trim() && num(it.grams) > 0);
  if (!items.length) { toast("Добавьте хотя бы один ингредиент с граммовкой", true); return; }
  const t = { g: 0, cal: 0, p: 0, f: 0, c: 0 };
  items.forEach(it => {
    const k = num(it.grams) / 100;
    t.g += num(it.grams); t.cal += num(it.cal) * k; t.p += num(it.p) * k; t.f += num(it.f) * k; t.c += num(it.c) * k;
  });
  const finished = num($("#rbFinished") ? $("#rbFinished").value : recipeCtx.finished) || t.g; // тот же вес, что в превью
  const k = 100 / finished;
  const cf = touch({
    id: recipeCtx.id || uid(), name,
    cal: round1(t.cal * k), p: round1(t.p * k), f: round1(t.f * k), c: round1(t.c * k),
    recipe: {
      totalGrams: Math.round(t.g), finishedGrams: finished, finishedAuto: !recipeCtx.finishedTouched,
      items: items.map(it => ({ name: it.name.trim(), grams: num(it.grams), cal: num(it.cal), p: num(it.p), f: num(it.f), c: num(it.c), autoCal: !!it.autoCal }))
    }
  });
  if (recipeCtx.id) data.customFoods = data.customFoods.map(x => x.id === recipeCtx.id ? cf : x);
  else data.customFoods.push(cf);
  closeModal();
  refresh();
  toast(`«${name}» сохранено в «Мои блюда» — записывайте, сколько грамм съели`);
}

function loadSamplePlans() {
  let added = 0;
  SAMPLE_PLANS.forEach(sp => {
    if (!data.plans.some(p => p.name === sp.name)) { data.plans.push({ id: uid(), name: sp.name, exercises: sp.exercises }); added++; }
  });
  refresh();
  toast(added ? `Добавлено планов: ${added}` : "Примеры уже добавлены");
}

/* ================= ПРОГРЕСС ================= */
function sortedWeights() { return [...data.weights].sort((a, b) => a.date.localeCompare(b.date) || a.createdAt - b.createdAt); }

function renderProgress() {
  const weights = sortedWeights();
  const s = data.settings;

  // статистика веса
  if (weights.length) {
    const first = weights[0].kg, last = weights[weights.length - 1].kg;
    const diff = last - first;
    $("#weightStats").innerHTML = `<div class="stat-grid">
      <div class="card"><span>Было</span><strong>${first.toFixed(1)} кг</strong></div>
      <div class="card"><span>Сейчас</span><strong>${last.toFixed(1)} кг</strong></div>
      <div class="card"><span>Изменение</span><strong style="color:${diff < 0 ? "var(--green)" : diff > 0 ? "var(--danger)" : "#fff"}">${diff > 0 ? "+" : ""}${diff.toFixed(1)} кг</strong></div>
    </div>`;
  } else {
    $("#weightStats").innerHTML = `<div class="empty">Запишите вес хотя бы пару раз — появятся график и прогноз.</div>`;
  }

  // график веса (SVG)
  $("#weightChart").innerHTML = weights.length >= 2 ? weightChartSvg(weights) : "";

  // график калорий
  const days = [];
  for (let i = 13; i >= 0; i--) days.push(shiftDate(todayStr(), -i));
  const vals = days.map(d => Math.round(sum(foodsFor(d), "cal")));
  $("#calChart").innerHTML = calChartSvg(days, vals, num(s.goalCal));
  $("#goalCalLabel").textContent = num(s.goalCal) ? `${s.goalCal} ккал` : "не задана (укажи в настройках)";

  renderForecast(weights);
  renderWeekly(days, vals);
  renderStats();
  renderRecords();
  renderAcwr();
  renderRadar();
  renderGoalBanner(weights);
  if (progTab === "loads") renderLoads();

  // история веса
  const recent = [...weights].reverse().slice(0, 10);
  $("#weightList").innerHTML = recent.length ? recent.map(w => `
    <div class="item"><div class="item-main"><div class="name">${w.kg.toFixed(1)} кг</div><small>${fmtDateRu(w.date)}</small></div>
      <button class="icon-btn" data-action="delWeight" data-id="${w.id}">✕</button></div>`).join("")
    : emptyScene("Записей веса пока нет", "Взвесьтесь и сохраните первую запись — появятся график и прогноз");
}

function weightChartSvg(weights) {
  const w = 640, h = 200, pad = 34;
  const kg = weights.map(x => x.kg);
  let min = Math.min(...kg), max = Math.max(...kg);
  if (max - min < 1) { min -= 0.5; max += 0.5; }
  const span = max - min;
  const X = i => pad + (weights.length === 1 ? 0 : i * (w - pad * 2) / (weights.length - 1));
  const Y = v => h - pad - (v - min) / span * (h - pad * 2);
  const pts = weights.map((x, i) => `${X(i).toFixed(1)},${Y(x.kg).toFixed(1)}`).join(" ");
  const area = `${pad},${h - pad} ${pts} ${X(weights.length - 1).toFixed(1)},${h - pad}`;
  const labels = weights.length > 1 ? [0, Math.floor(weights.length / 2), weights.length - 1].map(i => `
    <text x="${X(i)}" y="${h - 10}" fill="#8ba3c4" font-size="11" text-anchor="${i === 0 ? "start" : i === weights.length - 1 ? "end" : "middle"}">${fmtDateShort(weights[i].date)}</text>`).join("") : "";
  const goal = num(data.settings.goalWeight);
  const goalLine = goal && goal >= min && goal <= max ? `<line x1="${pad}" x2="${w - pad}" y1="${Y(goal)}" y2="${Y(goal)}" stroke="#3fd08a" stroke-dasharray="5 5" stroke-width="1.5"/><text x="${w - pad}" y="${Y(goal) - 6}" fill="#3fd08a" font-size="11" text-anchor="end">цель ${goal} кг</text>` : "";
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}">
    <polyline points="${area}" fill="rgba(77,163,255,.12)" stroke="none"/>
    <line x1="${pad}" x2="${w - pad}" y1="${Y(max + span * .05)}" y2="${Y(max + span * .05)}" stroke="#1e3150"/>
    <polyline points="${pts}" fill="none" stroke="#4da3ff" stroke-width="2.5" stroke-linejoin="round"/>
    ${weights.map((x, i) => `<circle cx="${X(i)}" cy="${Y(x.kg)}" r="3.5" fill="#4da3ff"/>`).join("")}
    ${goalLine}${labels}
    <text x="${pad}" y="${Y(max) - 6}" fill="#8ba3c4" font-size="11">${max.toFixed(1)} кг</text>
    <text x="${pad}" y="${Y(min) + 16}" fill="#8ba3c4" font-size="11">${min.toFixed(1)} кг</text>
  </svg>`;
}

function calChartSvg(days, vals, goal) {
  const w = 640, h = 200, pad = 34;
  const maxV = Math.max(goal || 0, ...vals, 500);
  const bw = (w - pad * 2) / days.length * 0.62;
  const step = (w - pad * 2) / days.length;
  const Y = v => h - pad - v / maxV * (h - pad * 2);
  const goalLine = goal ? `<line x1="${pad}" x2="${w - pad}" y1="${Y(goal)}" y2="${Y(goal)}" stroke="#3fd08a" stroke-dasharray="5 5" stroke-width="1.5"/><text x="${w - pad}" y="${Y(goal) - 5}" fill="#3fd08a" font-size="11" text-anchor="end">цель</text>` : "";
  const bars = days.map((d, i) => {
    const v = vals[i];
    const x = pad + i * step + (step - bw) / 2;
    const y = Y(v);
    const col = v ? (goal && v > goal ? "#e0684f" : "#4da3ff") : "#22314e";
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${(h - pad - y).toFixed(1)}" rx="3" fill="${col}"/>`;
  }).join("");
  const labels = [0, Math.floor(days.length / 2), days.length - 1].map(i => `
    <text x="${pad + i * step + step / 2}" y="${h - 10}" fill="#8ba3c4" font-size="11" text-anchor="middle">${fmtDateShort(days[i])}</text>`).join("");
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}">${bars}${goalLine}${labels}</svg>`;
}

function renderForecast(weights) {
  const el = $("#forecastPanel");
  const s = data.settings;
  const goal = num(s.goalWeight);
  if (!goal) {
    el.innerHTML = `<div class="section-title">Прогноз достижения цели</div>
      <div class="sub">Укажите цель веса в настройках — и приложение посчитает, к какому дню вы придёте к ней с текущим темпом.</div>`;
    return;
  }
  if (weights.length < 3) {
    el.innerHTML = `<div class="section-title">Прогноз достижения цели</div>
      <div class="sub">Нужно минимум 3 записи веса (и хотя бы 1–2 недели наблюдений), чтобы построить прогноз.</div>`;
    return;
  }
  const first = weights[0], last = weights[weights.length - 1];
  const dayMs = 86400000;
  const spanDays = (new Date(last.date) - new Date(first.date)) / dayMs;
  if (spanDays < 7) {
    el.innerHTML = `<div class="section-title">Прогноз достижения цели</div>
      <div class="sub">Записывайте вес хотя бы неделю — тогда появится прогноз.</div>`;
    return;
  }
  // линейная регрессия
  const n = weights.length;
  const xs = weights.map(x => (new Date(x.date) - new Date(first.date)) / dayMs);
  const ys = weights.map(x => x.kg);
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  const slope = xs.reduce((s2, x, i) => s2 + (x - mx) * (ys[i] - my), 0) / xs.reduce((s2, x) => s2 + (x - mx) ** 2, 0);
  const cur = last.kg;
  const diff = cur - goal;
  const perWeek = slope * 7;
  const stale = (Date.now() - new Date(last.date).getTime()) > 14 * 86400000;
  const staleNote = stale ? " Последняя запись веса старше двух недель — обновите её для точного прогноза." : "";
  let html = `<div class="section-title">Прогноз достижения цели</div>`;
  if (Math.abs(diff) <= 0.3) {
    html += `<div class="big">Цель практически достигнута</div><div class="sub">Текущий вес ${cur.toFixed(1)} кг при цели ${goal} кг. Отличная работа — осталось удерживать результат.</div>`;
  } else if (Math.abs(slope) < 0.004) {
    html += `<div class="big">Вес держится на месте</div><div class="sub">Темп: ${fmtNum(Math.abs(perWeek))} кг в неделю. Чтобы двигаться к цели ${goal} кг, скорректируйте питание или активность.${staleNote}</div>`;
  } else if ((diff > 0 && slope > 0) || (diff < 0 && slope < 0)) {
    const dir = diff > 0 ? "растёт" : "снижается";
    const need = diff > 0 ? "снизить" : "набрать";
    html += `<div class="big">Сейчас вес ${dir}</div><div class="sub">Цель — ${goal} кг, тренд ${fmtNum(Math.abs(perWeek))} кг в неделю. Чтобы ${need} вес, темп нужно развернуть.${staleNote}</div>`;
  } else {
    const daysToGoal = Math.abs(diff / slope);
    if (daysToGoal > 730) {
      html += `<div class="big">Цель достижима, но не скоро</div><div class="sub">С текущим темпом (${fmtNum(Math.abs(perWeek))} кг в неделю) до цели ${goal} кг уйдёт больше двух лет — чуть скорректируйте план, и получится быстрее.${staleNote}</div>`;
    } else {
      const target = new Date(); target.setDate(target.getDate() + Math.round(daysToGoal));
      html += `<div class="big">С таким темпом вы достигнете цели ${goal} кг к ${fmtDateRu(target.toISOString().slice(0, 10))}</div>
        <div class="sub">Темп: ${fmtNum(Math.abs(perWeek))} кг в неделю. Прогноз приблизительный: он просто продлевает текущую динамику вперёд.${staleNote}</div>`;
    }
  }
  el.innerHTML = html;
}

/* ---------- Объём по группам мышц ---------- */
// Сопоставление упражнения → группа по ключевым словам. Проверка сверху вниз, первое совпадение.
// ВАЖНО: более специфичные правила — выше общих. "Пресс" выше "Грудь" потому что
// "жим на скамье для пресса" содержит и "жим", и "пресс", но это упражнение на пресс!
const GROUP_RULES = [
  { g: "Ноги", re: /присед|жим ногами|жим ног|выпад|икр|носк|румынск|гиперэкст|бедр|голен|разгибани[а-яё]*(?: в тренажёр| лёжа| сидя| ног|\s*$)|сгибани[а-яё]*(?: в тренажёр| лёжа| сидя| ног|\s*$)/ },
  { g: "Пресс", re: /пресс|скруч|планк|живот|корп|вращен.*кор|пресс\b|абс|core|супермен|мостик|гиперэкс|разгибани.*спин/ },
  { g: "Трицепс", re: /трицепс|французск|из-за голов|разгибани[а-яё]* (на блоке|с гантел)|кикбэк|алмазн/ },
  { g: "Бицепс", re: /бицепс|биц\b|молотк|сгибани[а-яё]* (со штанг|с гантел|на скамье|на бицепс|штанг)/ },
  { g: "Плечи", re: /армейск|жим (сидя|гантелей сидя)|махи|подбород|дельт|плеч/ },
  { g: "Спина", re: /тяг[ауо]|подтяг|шраг|широчайш|спин|пуловер/ },
  { g: "Грудь", re: /жим|разводк|бабочк|кроссовер|брусья|отжимани|сведени|наклон/ }
];
function exGroup(name) {
  const n = String(name || "").toLowerCase().replace(/ё/g, "е");
  for (const r of GROUP_RULES) if (r.re.test(n)) return r.g;
  return null;
}
// тоннаж (вес × повторы) по группам за указанные даты, кг
function groupVolumes(dates) {
  const vols = {};
  data.workouts.forEach(w => {
    if (!dates.includes(w.date)) return;
    workoutExercises(w).forEach(ex => {
      const g = exGroup(ex.name);
      if (!g) return;
      (ex.sets || []).forEach(s => {
        const reps = parseFloat(String(s.reps || "").replace(",", ".")) || 0;
        vols[g] = (vols[g] || 0) + num(s.weight) * reps;
      });
    });
  });
  return vols;
}

function renderWeekly(days, vals) {
  const last7 = days.slice(-7), cal7 = vals.slice(-7);
  const withEntries = cal7.filter(v => v > 0);
  const avgCal = withEntries.length ? Math.round(withEntries.reduce((a, b) => a + b, 0) / withEntries.length) : 0;
  const weekFoods = last7.reduce((acc, d) => acc.concat(foodsFor(d)), []);
  const avgP = withEntries.length ? sum(weekFoods, "p") / withEntries.length : 0;
  const avgF = withEntries.length ? sum(weekFoods, "f") / withEntries.length : 0;
  const avgC = withEntries.length ? sum(weekFoods, "c") / withEntries.length : 0;
  const wkouts = last7.reduce((acc, d) => acc.concat(data.workouts.filter(w => w.date === d)), []);
  const wkMin = sum(wkouts, "minutes");
  // вес за неделю
  const weights = sortedWeights();
  let wDiff = null;
  if (weights.length >= 2) {
    const now = weights[weights.length - 1];
    const weekAgo = [...weights].reverse().find(x => x.date <= shiftDate(todayStr(), -7)) || weights[0];
    if (weekAgo && weekAgo.date !== now.date) wDiff = now.kg - weekAgo.kg;
  }
  // серия дней с записями
  let streak = 0;
  for (let i = 0; ; i++) {
    const d = shiftDate(todayStr(), -i);
    if (foodsFor(d).length || data.workouts.some(w => w.date === d)) streak++;
    else if (i === 0) continue; else break;
    if (i > 365) break;
  }
  const deloadWeek = wkouts.length > 0 && wkouts.every(w => w.deload);
  // объём по группам мышц: эта неделя vs предыдущая
  const gv = groupVolumes(last7);
  const gvPrev = groupVolumes(days.slice(0, 7));
  const gvBox = Object.keys(gv).length ? `<div class="section-title" style="margin-top:14px">Объём за неделю (по группам)${deloadWeek ? ' <span class="badge">💤 разгрузочная</span>' : ""}</div>
    <div class="review-grid">${Object.entries(gv).map(([g, kg]) => {
      const prev = gvPrev[g] || 0;
      const diff = ((kg - prev) / 1000).toFixed(1).replace(".", ",");
      const dTxt = prev ? (kg > prev * 1.05 ? ` ▲ +${diff} т` : kg < prev * 0.95 ? ` ▼ ${diff} т` : " · ≈") : "";
      return `<div class="card"><span>${g}</span><strong>${(kg / 1000).toFixed(1).replace(".", ",")} т</strong><small>${prev ? "было " + (prev / 1000).toFixed(1).replace(".", ",") + " т" : "впервые"}${dTxt}</small></div>`;
    }).join("")}</div>` : (deloadWeek ? `<div class="hint" style="margin-top:10px">💤 Разгрузочная неделя</div>` : "");
  $("#weeklyReview").innerHTML = `<div class="review-grid">
    <div class="card"><span>Средние калории</span><strong>${avgCal} ккал/день</strong></div>
    <div class="card"><span>Б / Ж / У в среднем</span><strong>${fmtNum(avgP)} / ${fmtNum(avgF)} / ${fmtNum(avgC)} г</strong></div>
    <div class="card"><span>Тренировки</span><strong>${wkouts.length} шт · ${wkMin} мин</strong></div>
    <div class="card"><span>Вес за неделю</span><strong>${wDiff == null ? "—" : (wDiff > 0 ? "+" : "") + wDiff.toFixed(1) + " кг"}</strong></div>
    <div class="card"><span>Серия дней</span><strong>${streak} ${plural(streak, "день", "дня", "дней")} 🔥</strong></div>
  </div>${gvBox}`;
}

/* ================= МАСКОТ ================= */
// Позы-картинки лежат в папке mascot/ (main, win, hello, rest, ok).
// Пустое состояние с маскотом: картинка позы + заголовок + подпись
function emptyScene(title, sub, pose) {
  const file = pose || "main";
  return `<div class="empty-scene"><img class="mascot-img" src="mascot/${file}.png" alt="маскот"><div class="empty-title">${esc(title)}</div>${sub ? `<div class="empty-sub">${esc(sub)}</div>` : ""}</div>`;
}

/* ---------- Сводка за всё время ---------- */
/* ---------- Рекорды упражнений ---------- */
function workoutRecords() {
  const byName = {};
  const histBy = {};
  data.workouts.forEach(w => {
    workoutExercises(w).forEach(ex => (ex.sets || []).forEach(s => {
      if (s.weight == null || s.weight === "") return;
      const kg = num(s.weight);
      const repsN = parseFloat(String(s.reps || "").replace(",", ".")) || 0;
      (histBy[ex.name] = histBy[ex.name] || []).push({ date: w.date, kg, reps: repsN });
      const rec = byName[ex.name] || (byName[ex.name] = { name: ex.name, bestVol: 0, volDate: null });
      const vol = kg * repsN;
      if (vol > rec.bestVol) { rec.bestVol = vol; rec.volDate = w.date; }
    }));
  });
  const out = [];
  Object.keys(byName).forEach(name => {
    const hist = histBy[name].sort((a, b) => a.date.localeCompare(b.date) || a.kg - b.kg);
    let maxKg = 0, maxReps = 0, maxDate = null;
    hist.forEach(p => {
      if (p.kg > maxKg || (p.kg === maxKg && p.reps > maxReps)) { maxKg = p.kg; maxReps = p.reps; maxDate = p.date; }
    });
    // предыдущий максимум — самый тяжёлый вес строго меньше рекорда
    const prevKg = maxKg ? Math.max(0, ...hist.filter(p => p.kg < maxKg).map(p => p.kg)) : 0;
    out.push({ name, maxKg, maxReps, maxDate, prevKg, bestVol: byName[name].bestVol, volDate: byName[name].volDate });
  });
  const hidden = data.settings.hiddenRecs || [];
  const cutoff = shiftDate(todayStr(), -7);
  return out
    .filter(r => !hidden.includes(r.name))
    .map(r => ({ ...r, isNew: r.maxDate >= cutoff }))
    .sort((a, b) => b.maxKg - a.maxKg)
    .slice(0, 12);
}

function renderRecords() {
  const el = $("#recordsList");
  if (!el) return;
  const recs = workoutRecords();
  const hidden = data.settings.hiddenRecs || [];
  el.innerHTML = recs.length ? recs.map(r => {
    const delta = r.prevKg ? Math.round((r.maxKg - r.prevKg) * 10) / 10 : 0;
    const dTxt = delta > 0 ? `<span style="color:var(--green);font-size:12px">▲ +${fmtNum(delta)}</span>` : (delta === 0 && r.prevKg ? `<span style="color:var(--muted);font-size:12px">=</span>` : "");
    const bwt = bodyWeightAt(r.maxDate);
    const pct = bwt ? Math.round(r.maxKg / bwt * 100) : null;
    return `
    <div class="item">
      <div class="item-main"><div class="name">${esc(r.name)}${r.isNew ? ` <span class="badge">NEW</span>` : ""}</div>
        <small>${r.maxReps ? `${fmtNum(r.maxKg)} кг × ${r.maxReps}` : `${fmtNum(r.maxKg)} кг`} · ${fmtDateShort(r.maxDate)}${pct ? ` · ${pct}% веса тела` : ""}${r.bestVol ? ` · лучший подход ${Math.round(r.bestVol)} кг` : ""}</small></div>
      <span class="kcal">${fmtNum(r.maxKg)} кг ${dTxt}</span>
      <button class="icon-btn" data-action="hideRecord" data-name="${esc(r.name)}" title="Скрыть из рекордов">✕</button>
    </div>`}).join("") + (hidden.length ? `<div class="hint" style="margin-top:8px">Скрыто: ${hidden.length} · <button class="small ghost" data-action="showHiddenRecords">Показать снова</button></div>` : "") : emptyScene("Пока нет рекордов", "Запишите первые тренировки с весом — и здесь появится топ");
}

// Иконка приёма пищи (из набора art/)
function mealIcon(meal) {
  const map = { "Завтрак": "breakfast", "Обед": "lunch", "Ужин": "dinner", "Перекус": "snack", "Полдник": "snack", "Второй завтрак": "breakfast" };
  const f = map[meal];
  return f ? `<img class="micon" src="art/icon-${f}.png" alt="${esc(meal)}">` : "";
}

// Баннер «Цель достигнута» (показываем, когда вес в пределах цели)
function renderGoalBanner(weights) {
  const el = $("#goalBanner");
  if (!el) return;
  const goal = num(data.settings.goalWeight);
  const cur = weights.length ? weights[weights.length - 1].kg : null;
  const reached = goal && cur != null && Math.abs(cur - goal) <= 0.35;
  el.innerHTML = reached ? `<div class="goal-banner"><img src="art/banner.png" alt="Цель достигнута!"></div>` : "";
}

/* ---------- Прогрессия нагрузок (подвкладка Прогресса) ---------- */
let progTab = "overview";
function progSwitch(tab) {
  progTab = tab;
  $$("#progSeg button").forEach(b => b.classList.toggle("on", b.dataset.tab === tab));
  const ov = $("#progOverview"), ld = $("#progLoads");
  if (ov) ov.style.display = tab === "overview" ? "" : "none";
  if (ld) ld.style.display = tab === "loads" ? "" : "none";
  if (tab === "loads") renderLoads();
}
function loaderHistory(name) {
  const n = normExName(name);
  const pts = [];
  data.workouts.forEach(w => {
    workoutExercises(w).forEach(ex => {
      if (normExName(ex.name) !== n || !ex.sets || !ex.sets.length) return;
      const best = ex.sets.reduce((b, s) => {
        const wgt = num(s.weight), reps = parseFloat(String(s.reps || "").replace(",", ".")) || 0;
        return wgt > b.kg ? { kg: wgt, reps, vol: wgt * reps } : b;
      }, { kg: 0, reps: 0, vol: 0 });
      pts.push({ date: w.date, kg: best.kg, reps: best.reps, vol: best.vol });
    });
  });
  return pts.sort((a, b) => a.date.localeCompare(b.date));
}

// Оценка 1ПМ по формуле Брызки: weight × (36 / (36 - reps)) — точнее для малых повторов
function e1rm(kg, reps) {
  if (kg <= 0 || reps <= 0 || reps >= 36) return 0;
  return Math.round(kg * (36 / (36 - reps)) * 10) / 10;
}

// вес тела на дату (последняя запись не позже date)
function bodyWeightAt(date) {
  const w = [...data.weights].filter(x => x.date <= date).sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || 0) - (a.createdAt || 0))[0];
  return w ? w.kg : null;
}

// лучший подход упражнения во всей истории, кроме тренировки wid (PR-детекция)
function bestSetFor(exName, wid) {
  const n = normExName(exName);
  let best = null;
  data.workouts.forEach(w => {
    if (w.id === wid) return;
    workoutExercises(w).forEach(ex => {
      if (normExName(ex.name) !== n) return;
      (ex.sets || []).forEach(s => {
        const kg = num(s.weight);
        const reps = parseFloat(String(s.reps || "").replace(",", ".")) || 0;
        if (!best || kg > best.kg || (kg === best.kg && reps > best.reps)) best = { kg, reps, date: w.date };
      });
    });
  });
  return best;
}

// график: синяя — лучший вес подхода, фиолетовый пунктир — 1ПМ
function loadChartSvg(pts) {
  const w = 640, h = 210, pad = 36;
  const withKg = pts.filter(p => p.kg > 0);
  const e1s = pts.map(p => e1rm(p.kg, p.reps)).filter(v => v > 0);
  let min = Math.min(...withKg.map(p => p.kg), ...e1s), max = Math.max(...withKg.map(p => p.kg), ...e1s);
  if (max - min < 2) { min -= 1; max += 1; }
  const span = max - min;
  const X = i => pad + i * (w - pad * 2) / Math.max(1, pts.length - 1);
  const Y = v => h - pad - (v - min) / span * (h - pad * 2);
  const bestLine = pts.map((p, i) => `${X(i).toFixed(1)},${Y(Math.max(p.kg, min)).toFixed(1)}`).join(" ");
  const e1Line = pts.map((p, i) => `${X(i).toFixed(1)},${Y(Math.max(e1rm(p.kg, p.reps), min)).toFixed(1)}`).join(" ");
  const area = `${pad},${h - pad} ${bestLine} ${X(pts.length - 1).toFixed(1)},${h - pad}`;
  const labels = [0, Math.floor(pts.length / 2), pts.length - 1].map(i => `<text x="${X(i)}" y="${h - 8}" fill="#8ba3c4" font-size="10" text-anchor="${i === 0 ? "start" : i === pts.length - 1 ? "end" : "middle"}">${fmtDateShort(pts[i].date)}</text>`).join("");
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}">
    <polyline points="${area}" fill="rgba(77,163,255,.10)" stroke="none"/>
    <polyline points="${e1Line}" fill="none" stroke="#8b5cf6" stroke-width="1.5" stroke-dasharray="5 4"/>
    <polyline points="${bestLine}" fill="none" stroke="#4da3ff" stroke-width="2.5" stroke-linejoin="round"/>
    ${pts.map((p, i) => `<circle cx="${X(i)}" cy="${Y(Math.max(p.kg, min))}" r="3.5" fill="#4da3ff"/><circle cx="${X(i)}" cy="${Y(Math.max(e1rm(p.kg, p.reps), min))}" r="2.5" fill="#8b5cf6"/>`).join("")}
    <text x="${pad}" y="${Y(max) - 8}" fill="#8ba3c4" font-size="10">${fmtNum(max)} кг</text>
    <text x="${pad}" y="${Y(min) + 18}" fill="#8ba3c4" font-size="10">${fmtNum(min)} кг</text>
    ${labels}</svg>`;
}

// все подходы упражнения за конкретную дату (для таблицы)
function setsForDate(exName, date) {
  const n = normExName(exName);
  for (const w of data.workouts) {
    if (w.date !== date) continue;
    for (const ex of workoutExercises(w)) {
      if (normExName(ex.name) === n && ex.sets && ex.sets.length) return setsLine(ex.sets);
    }
  }
  return "";
}

function drawLoadDetail(cur) {
  const pts = loaderHistory(cur);
  const withKg = pts.filter(p => p.kg > 0);
  const bestP = withKg.reduce((b, p) => (p.kg > b.kg ? p : b), { kg: 0, reps: 0, date: "" });
  const lastP = withKg.length ? withKg[withKg.length - 1] : null;
  const e1last = lastP ? e1rm(lastP.kg, lastP.reps) : 0;
  const e1first = withKg.length ? e1rm(withKg[0].kg, withKg[0].reps) : 0;
  const growth = e1last && e1first ? Math.round((e1last - e1first) * 10) / 10 : 0;
  const statsEl = $("#loadStats"), chartEl = $("#loadChart"), legEl = $("#loadLegend"), tblEl = $("#loadTable");
  if (!statsEl) return;
  statsEl.innerHTML = `<div class="card"><span>Лучший подход</span><strong>${bestP.kg ? `${fmtNum(bestP.kg)} кг × ${bestP.reps}` : "—"}</strong><small>${bestP.date || ""}</small></div>
    <div class="card"><span>1ПМ сейчас</span><strong>${e1last ? fmtNum(e1last) + " кг" : "—"}</strong><small>расчётный максимум на 1 повтор</small></div>
    <div class="card"><span>Рост с первой записи</span><strong style="color:${growth > 0.4 ? "var(--green)" : growth < -0.4 ? "var(--danger)" : ""}">${growth > 0 ? "+" : ""}${fmtNum(growth)} кг</strong><small>по 1ПМ</small></div>`;
  const ready = withKg.length >= 2;
  chartEl.innerHTML = ready ? loadChartSvg(pts) : `<div class="empty">${pts.length < 2 ? "Нужно минимум 2 тренировки с этим упражнением." : "Здесь только подходы с собственным весом."}</div>`;
  legEl.innerHTML = ready ? `<div class="hint" style="margin-top:6px">Синяя линия — лучший вес подхода · фиолетовая пунктирная — 1ПМ (как бы тянул на 1 повтор)</div><div class="btn-row" style="margin-top:8px"><button class="small ghost" data-action="showLoadDetail" data-name="${esc(cur)}">📊 Показать всю историю</button></div>` : "";
  tblEl.innerHTML = rows.length ? `<div class="list">${rows.map(p => `
    <div class="item"><div class="item-main"><div class="name">${fmtDateRu(p.date)}</div>
      <small>${esc(setsForDate(cur, p.date)) || "подходы не записаны"}</small></div>
      <span class="kcal">${p.kg ? fmtNum(p.kg) + " кг × " + p.reps : p.reps + "×"}${bestP.kg && p.kg === bestP.kg ? " 🏆" : ""}<br><small style="color:#8ba3c4">1ПМ ${e1rm(p.kg, p.reps) ? fmtNum(e1rm(p.kg, p.reps)) : "—"}</small></span></div>`).join("")}</div>` : "";
}

/* ---------- Модальное окно полной истории нагрузки ---------- */
function showLoadDetailModal(name) {
  const pts = loaderHistory(name);
  if (!pts.length) { toast("Нет данных", true); return; }
  const rows = pts.map(p => {
    const sets = setsForDate(name, p.date);
    return `<tr><td>${fmtDateRu(p.date)}</td><td>${fmtNum(p.kg)} кг</td><td>${p.reps} повт</td><td>${e1rm(p.kg, p.reps) ? fmtNum(e1rm(p.kg, p.reps)) + " кг" : "—"}</td><td>${esc(sets) || "—"}</td></tr>`;
  }).join("");
  openModal(`
    <div class="modal-head"><h3>📊 ${esc(name)} — полная история</h3><button class="close-x" data-action="closeModal">✕</button></div>
    <div style="overflow-x:auto">
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead><tr style="border-bottom:1px solid var(--border);color:var(--text-secondary)">
          <th style="text-align:left;padding:6px">Дата</th>
          <th style="text-align:right;padding:6px">Вес</th>
          <th style="text-align:right;padding:6px">Повт</th>
          <th style="text-align:right;padding:6px">1ПМ</th>
          <th style="text-align:left;padding:6px">Подходы</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `);
}

function renderLoads() {
  const sel = $("#loadEx");
  if (!sel) return;
  const count = {};
  data.workouts.forEach(w => (workoutExercises(w) || []).forEach(e => { if (e.name) count[e.name] = (count[e.name] || 0) + 1; }));
  const names = Object.keys(count).sort((a, b) => count[b] - count[a]);
  if (!names.length) { sel.innerHTML = `<option>нет упражнений</option>`; return; }
  if (!sel.options.length) sel.innerHTML = names.map(n => `<option>${esc(n)}</option>`).join("");
  sel.removeEventListener("change", onLoadExChange);
  sel.addEventListener("change", onLoadExChange);
  drawLoadDetail(sel.value && names.includes(sel.value) ? sel.value : names[0]);
  const list = $("#sparkList");
  if (list) list.innerHTML = names.slice(0, 15).map(n => {
    const h = loaderHistory(n);
    if (!h.length) return "";
    const last = h[h.length - 1], first = h[0];
    const delta = Math.round((e1rm(last.kg, last.reps) - e1rm(first.kg, first.reps)) * 10) / 10;
    const dTxt = delta > 0.4 ? `<span style="color:var(--green)">▲ +${fmtNum(delta)} кг 1ПМ</span>` : delta < -0.4 ? `<span style="color:var(--danger)">▼ ${fmtNum(delta)} кг</span>` : `<span>· без роста</span>`;
    return `<div class="item" style="cursor:pointer" data-action="loadPick" data-name="${esc(n)}">
      <div class="item-main"><div class="name">${esc(n)}</div>
      <small>${last.kg ? `${fmtNum(last.kg)} кг × ${last.reps} · 1ПМ ${fmtNum(e1rm(last.kg, last.reps))} кг` : `${last.reps} повт`} · ${dTxt}</small></div>
      <span class="kcal">${last.kg ? fmtNum(last.kg) + " кг" : last.reps + "×"}</span></div>`;
  }).join("") || `<div class="empty">Пока нет упражнений.</div>`;
}
function onLoadExChange() { const sel = $("#loadEx"); if (sel && sel.value) drawLoadDetail(sel.value); }

/* ---------- Нагрузка и ACWR ---------- */
function lastNDates(n) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(shiftDate(todayStr(), -i));
  return out;
}
// тоннаж (кг: вес × повторы) тренировок за указанные даты
function tonnageForDates(dates) {
  let t = 0;
  data.workouts.forEach(w => {
    if (!dates.includes(w.date)) return;
    workoutExercises(w).forEach(ex => (ex.sets || []).forEach(s => {
      const reps = parseFloat(String(s.reps || "").replace(",", ".")) || 0;
      t += num(s.weight) * reps;
    }));
  });
  return Math.round(t);
}
function acwrStats() {
  const d7 = tonnageForDates(lastNDates(7));
  const d28 = tonnageForDates(lastNDates(28));
  const chronicWeek = Math.round(d28 / 4);
  const acwr = d28 > 0 ? Math.round(d7 / Math.max(1, chronicWeek) * 100) / 100 : null;
  return { d7, d28, chronicWeek, acwr };
}
function acwrZone(v) {
  if (v == null) return null;
  if (v < 0.8) return { key: "rest", txt: "Низкая нагрузка — восстановление" };
  if (v <= 1.3) return { key: "ok", txt: "Оптимально ✓" };
  if (v <= 1.5) return { key: "high", txt: "Высокая — прислушайся к организму" };
  return { key: "risk", txt: "Риск перетренированности — отдохни" };
}
const fmtTons = kg => kg >= 1000 ? (kg / 1000).toFixed(1).replace(".", ",") + " т" : kg + " кг";

function renderAcwr() {
  const el = $("#acwrBox");
  if (!el) return;
  const s = acwrStats();
  if (s.d7 === 0 && s.d28 === 0) {
    el.innerHTML = `<div class="empty">Запиши тренировки — появится индикатор нагрузки: 7 дней против среднего за 28 (ACWR).</div>`;
    return;
  }
  const zone = acwrZone(s.acwr);
  const pct = s.acwr == null ? 0 : Math.min(100, Math.max(0, s.acwr / 2 * 100));
  el.innerHTML = `
    <div class="acwr-rows">
      <div class="acwr-row"><span>Нагрузка за 7 дней</span><b>${fmtTons(s.d7)}</b></div>
      <div class="acwr-row"><span>Средняя неделя (за 28 дней)</span><b>${s.chronicWeek ? fmtTons(s.chronicWeek) : "—"}</b></div>
    </div>
    <div class="acwr-track"><div class="acwr-marker" style="left:${pct}%"></div></div>
    <div class="acwr-foot"><b>${s.acwr == null ? "—" : s.acwr.toFixed(2).replace(".", ",")}</b> · ${zone ? zone.txt : "накопление данных"}</div>
    <div class="hint" style="margin-top:6px">ACWR = нагрузка за 7 дней ÷ средняя неделя. &lt;0,8 — мало, 0,8–1,3 — зона роста, &gt;1,5 — риск.</div>`;
}

/* ---------- Радар баланса мышечных групп ---------- */
function radarSvg(groups, vals, max) {
  const W = 340, H = 310, cx = 170, cy = 160, R = 100;
  const n = groups.length;
  const ang = i => -Math.PI / 2 + i * 2 * Math.PI / n;
  const pt = (i, r) => [cx + Math.cos(ang(i)) * r, cy + Math.sin(ang(i)) * r];
  const ring = r => groups.map((_, i) => pt(i, r).map(v => v.toFixed(1)).join(",")).join(" ");
  const poly = vals.map((v, i) => pt(i, max ? v / max * R : 0).map(x => x.toFixed(1)).join(",")).join(" ");
  const axis = groups.map((_, i) => { const [x, y] = pt(i, R); return `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="rgba(43,63,99,.6)"/>`; }).join("");
  const labels = groups.map((g, i) => {
    const [x, y] = pt(i, R + 26);
    const a = ang(i);
    const anc = Math.abs(a) < 0.45 ? "middle" : (Math.cos(a) > 0 ? "start" : "end");
    const dy = Math.sin(a) > 0.2 ? 13 : 2;
    return `<text x="${x.toFixed(1)}" y="${(y + dy).toFixed(1)}" fill="#9db8dc" font-size="11" text-anchor="${anc}" font-weight="600">${g}</text>`;
  }).join("");
  const dots = vals.map((v, i) => { const [x, y] = pt(i, max ? v / max * R : 0); return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="#4da3ff"/>`; }).join("");
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:340px;display:block;margin:0 auto" aria-hidden="true">${axis}
    <polygon points="${ring(R * 0.33)}" fill="none" stroke="rgba(43,63,99,.5)"/>
    <polygon points="${ring(R * 0.66)}" fill="none" stroke="rgba(43,63,99,.5)"/>
    <polygon points="${ring(R)}" fill="none" stroke="rgba(43,63,99,.5)"/>
    <polygon points="${poly}" fill="rgba(77,163,255,.25)" stroke="#4da3ff" stroke-width="2"/>
    ${dots}${labels}</svg>`;
}

function renderRadar() {
  const el = $("#radarBox");
  if (!el) return;
  const vols = groupVolumes(lastNDates(28));
  const groups = EXERCISE_GROUPS.map(g => g.name);
  const vals = groups.map(g => Math.round(vols[g] || 0));
  const max = Math.max(...vals);
  if (max <= 0) {
    el.innerHTML = `<div class="empty">Нет данных за 28 дней — появится после тренировок с весом.</div>`;
    return;
  }
  el.innerHTML = radarSvg(groups, vals, max);
}

function renderStats() {
  const el = $("#statsPanel");
  if (!el) return;

  const days = new Set();
  data.foods.forEach(f => days.add(f.date));
  data.weights.forEach(w => days.add(w.date));
  data.workouts.forEach(w => days.add(w.date));

  const totalCal = sum(data.foods, "cal");

  let workouts = 0, minutes = 0, liftedKg = 0, setsCount = 0;
  data.workouts.forEach(w => {
    workouts++;
    minutes += num(w.minutes);
    workoutExercises(w).forEach(ex => (ex.sets || []).forEach(s => {
      setsCount++;
      const reps = String(s.reps || "").match(/\d+(?:[.,]\d+)?/);
      liftedKg += num(s.weight) * (reps ? parseFloat(reps[0].replace(",", ".")) : 0);
    }));
  });
  liftedKg = Math.round(liftedKg);

  const sorted = sortedWeights();
  const wDiff = sorted.length >= 2 ? sorted[sorted.length - 1].kg - sorted[0].kg : null;

  // серия дней
  let streak = 0;
  for (let i = 0; ; i++) {
    const d = shiftDate(todayStr(), -i);
    if (foodsFor(d).length || data.workouts.some(w => w.date === d)) streak++;
    else if (i === 0) continue; else break;
    if (i > 365) break;
  }

  // топ продуктов по суммарным калориям (итог дня — не продукт, исключаем)
  const byName = {};
  data.foods.forEach(f => {
    if (String(f.name).startsWith("Итог дня")) return;
    byName[f.name] = byName[f.name] || { cal: 0, n: 0 };
    byName[f.name].cal += num(f.cal);
    byName[f.name].n++;
  });
  const top = Object.entries(byName).sort((a, b) => b[1].cal - a[1].cal).slice(0, 5);

  // калорийный рекорд дня
  const byDay = {};
  data.foods.forEach(f => byDay[f.date] = (byDay[f.date] || 0) + num(f.cal));
  const bestDay = Object.entries(byDay).sort((a, b) => b[1] - a[1])[0];

  // бытовые сравнения
  const burgers = Math.round(totalCal / 550);
  const tons = liftedKg / 1000;
  let liftNote;
  if (tons >= 10) liftNote = `≈ ${Math.round(tons / 10)} городских автобусов 🚌`;
  else if (liftedKg >= 70) liftNote = `≈ ${Math.round(liftedKg / 70)} стиральных машин 🧺`;
  else liftNote = "продолжай расти 💪";

  el.innerHTML = `
    <div class="section-title">Сводка за всё время</div>
    ${days.size ? `<div class="stat-grid">
      <div class="card"><span>📅 Дней ведения</span><strong>${days.size}</strong><small>${fmtDateRu([...days].sort()[0])} — сегодня</small></div>
      <div class="card"><span>🍽 Съедено</span><strong>${(totalCal / 1000).toFixed(1).replace(".", ",")} тыс. ккал</strong><small>≈ ${burgers} бургеров 🍔</small></div>
      <div class="card"><span>🏋️ Тренировок</span><strong>${workouts}</strong><small>${minutes} мин · ${setsCount} ${plural(setsCount, "подход", "подхода", "подходов")}</small></div>
      <div class="card"><span>Поднято всего</span><strong>${tons >= 1 ? fmtNum(tons) + " т" : liftedKg + " кг"}</strong><small>${liftNote}</small></div>
      ${wDiff != null ? `<div class="card"><span>⚖️ Вес с начала</span><strong style="color:${wDiff < 0 ? "var(--green)" : wDiff > 0 ? "var(--danger)" : ""}">${wDiff > 0 ? "+" : ""}${wDiff.toFixed(1)} кг</strong><small>${sorted[0].kg.toFixed(1)} → ${sorted[sorted.length - 1].kg.toFixed(1)} кг</small></div>` : ""}
      <div class="card"><span>🔥 Серия дней</span><strong>${streak} ${plural(streak, "день", "дня", "дней")}</strong><small>подряд с записями</small></div>
    </div>` : emptyScene("Пока нет данных", "Начните вести дневник, и здесь появится ваша история")}
    ${top.length ? `<div class="section-title" style="margin-top:14px">Топ продуктов по калориям</div>
    <div class="list">${top.map(([name, v]) => `
      <div class="item"><div class="item-main"><div class="name">${esc(name)}</div><small>${v.n} ${plural(v.n, "раз", "раза", "раз")} · можно удалить ✕</small></div>
        <span class="kcal">${Math.round(v.cal)} ккал</span><button class="icon-btn" data-action="delTopFood" data-name="${esc(name)}" title="Удалить все записи «${esc(name)}»">✕</button></div>`).join("")}</div>
    <div class="hint" style="margin-top:8px">${bestDay ? `Рекорд: ${fmtDateRu(bestDay[0])} — ${Math.round(bestDay[1])} ккал за день 🏆` : ""}</div>` : ""}`;
}

/* ================= ПЛАН ПИТАНИЯ ================= */
function renderMealPlan() {
  $("#dateInputP").value = selectedDate;
  const items = data.mealPlan[selectedDate] || [];
  const cal = sum(items, "cal"), p = sum(items, "p"), f = sum(items, "f"), c = sum(items, "c");
  const goal = num(data.settings.goalCal);
  $("#mealPlanSummary").innerHTML = `<div class="summary" style="grid-template-columns:repeat(4,1fr)">
    <div class="card accent"><span>Запланировано</span><strong>${Math.round(cal)} ккал</strong><small>${goal ? Math.round(cal / goal * 100) + "% от цели" : "цель не задана"}</small></div>
    <div class="card"><span>Белки</span><strong>${fmtNum(p)} г</strong></div>
    <div class="card"><span>Жиры</span><strong>${fmtNum(f)} г</strong></div>
    <div class="card"><span>Углеводы</span><strong>${fmtNum(c)} г</strong></div>
  </div>`;

  const names = data.settings.mealNames.length ? data.settings.mealNames : ["Завтрак", "Обед", "Ужин", "Перекус"];
  $("#mealPlanSections").innerHTML = names.map(meal => {
    const mi = items.filter(x => x.meal === meal);
    return `<div class="meal-block">
      <div class="meal-head">${mealIcon(meal)}<b>${esc(meal)}</b><span class="meal-kcal">${Math.round(sum(mi, "cal"))} ккал</span></div>
      <div class="meal-body">
        ${mi.length ? mi.map(item => `
          <div class="item"><div class="item-main"><div class="name">${esc(item.name)}</div><small>${item.grams ? item.grams + " г · " : ""}Б: ${fmtNum(item.p)} · Ж: ${fmtNum(item.f)} · У: ${fmtNum(item.c)}</small></div>
            <div class="item-right"><span class="kcal">${Math.round(num(item.cal))} ккал</span><button class="icon-btn" data-action="delPlanItem" data-id="${item.id}">✕</button></div></div>`).join("")
          : `<div class="empty meal-empty"><img class="mini-mascot" src="mascot/rest.png" alt="">Не запланировано</div>`}
        <div class="meal-actions"><button class="small primary" data-action="addFood" data-meal="${esc(meal)}" data-target="plan">＋ Блюдо в план</button></div>
      </div>
    </div>`;
  }).join("");
}

function copyPlanToDiary() {
  const items = data.mealPlan[selectedDate] || [];
  if (!items.length) { toast("План на этот день пуст", true); return; }
  items.forEach(it => data.foods.push({ ...it, id: uid() }));
  refresh();
  toast(`Скопировано в дневник: ${items.length} ${plural(items.length, "блюдо", "блюда", "блюд")}`);
}

function applyTemplate(kind) {
  const t = MEAL_TEMPLATES[kind];
  data.mealPlan[selectedDate] = t.items.map(x => {
    const db = FOOD_DB.find(f => f.name === x.name) || { cal: 0, p: 0, f: 0, c: 0 };
    const k = x.grams / 100;
    return { id: uid(), date: selectedDate, meal: x.meal, name: x.name, grams: x.grams, cal: Math.round(db.cal * k), p: Math.round(db.p * k * 10) / 10, f: Math.round(db.f * k * 10) / 10, c: Math.round(db.c * k * 10) / 10 };
  });
  refresh();
  toast(`Применён пример меню: ${t.title} (не рекомендация врача)`);
}

/* ================= НАСТРОЙКИ ================= */
function renderSettings() {
  const s = data.settings;
  // цели
  const gf = $("[data-form=goals]");
  if (gf && document.activeElement && gf.contains(document.activeElement)) { /* не перезаписываем во время ввода */ }
  else {
    gf.querySelector("[name=goalCal]").value = s.goalCal || "";
    gf.querySelector("[name=goalP]").value = s.goalP || "";
    gf.querySelector("[name=goalF]").value = s.goalF || "";
    gf.querySelector("[name=goalC]").value = s.goalC || "";
    gf.querySelector("[name=goalWeight]").value = s.goalWeight || "";
    const gs = gf.querySelector("[name=calSex]"); if (gs) gs.value = s.sex || "м";
    const gh = gf.querySelector("[name=calHeight]"); if (gh) gh.value = s.height || "";
    const ga = gf.querySelector("[name=calAge]"); if (ga) ga.value = s.age || "";
    const gm = gf.querySelector("[name=calMode]"); if (gm) gm.value = s.mode || "";
  }
  // приёмы пищи
  $("#mealChips").innerHTML = s.mealNames.map((n, i) => `<span class="chip">${esc(n)}<button data-action="delMealName" data-i="${i}" title="Удалить">✕</button></span>`).join("");
  // синхронизация
  renderSyncSection();
  renderInstallGuide();
}

function renderSyncSection() {
  const el = $("#syncSection");
  if (!el) return;
  const s = data.settings;
  if (!s.firebaseConfig) {
    el.innerHTML = `
      <label class="field">Конфигурация Firebase (firebaseConfig)<textarea id="fbConfig" placeholder='{"apiKey":"...","authDomain":"...","projectId":"...","appId":"..."}' style="min-height:90px;font-family:monospace;font-size:12px"></textarea></label>
      <div class="btn-row"><button data-action="saveFbConfig">Сохранить конфиг</button></div>
      <p class="hint">Инструкция — ниже в пункте «Как настроить».</p>`;
    return;
  }
  const user = fbUser;
  if (!user) {
    el.innerHTML = `
      <div class="sync-status"><span class="sync-dot"></span> Конфиг сохранён. Войдите, чтобы включить синхронизацию.</div>
      <div class="btn-row"><button data-action="emailLogin">Войти по почте (проще всего)</button></div>
      <div class="btn-row"><button class="ghost" data-action="googleLogin">Или через Google</button></div>
      <div class="btn-row"><button class="ghost small" data-action="resetFbConfig">Сбросить конфиг</button></div>`;
    return;
  }
  el.innerHTML = `
    <div class="user-badge"><img src="${esc(user.photoURL || "")}" alt="" onerror="this.style.display='none'"><div><b style="font-size:14px">${esc(user.displayName || "Пользователь")}</b><div class="ub-mail">${esc(user.email)}</div></div></div>
    <div class="sync-status"><span class="sync-dot${syncState.ok ? " on" : syncState.err ? " err" : ""}"></span> ${esc(syncState.msg)}</div>
    <div class="btn-row">
      <button data-action="syncPush">Сохранить в облако</button>
      <button class="ghost" data-action="syncPull">Загрузить из облака</button>
    </div>
    <label class="field" style="margin-top:10px;display:flex;gap:8px;align-items:center;flex-direction:row"><input type="checkbox" data-action="autoSyncChk" style="width:18px;min-height:0" ${s.autoSync ? "checked" : ""}> Автосинхронизация при изменениях</label>
    <div class="btn-row"><button class="danger small" data-action="googleLogout">Выйти из аккаунта</button></div>`;
}

function renderInstallGuide() {
  const el = $("#installGuide");
  if (!el) return;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  el.innerHTML = `
    <p class="hint" style="margin:0 0 10px">Приложение работает офлайн и устанавливается на телефон как обычное приложение (PWA). Данные хранятся на устройстве.</p>
    ${installPromptEvent ? `<div class="btn-row" style="margin-top:0"><button data-action="installPwa">Установить приложение</button></div>` : ""}
    ${isIOS ? `<p class="hint"><b>iPhone:</b> откройте сайт в Safari → кнопка «Поделиться» (квадрат со стрелкой) → «На экран “Домой”».</p>
      <p class="hint"><b>Android:</b> в Chrome → меню (⋮) → «Установить приложение» / «Добавить на главный экран».</p>`
    : `<p class="hint"><b>Android:</b> в Chrome → меню (⋮) → «Установить приложение» / «Добавить на главный экран». <b>Компьютер:</b> значок установки в адресной строке.</p>`}`;
}

/* ================= FIREBASE СИНХРОНИЗАЦИЯ ================= */
let fbApp = null, fbAuth = null, fbDb = null, fbUser = null;
let syncState = { ok: false, err: false, msg: "Готово к синхронизации" };
let fbModules = null;

async function initFirebase(quiet) {
  const cfgText = data.settings.firebaseConfig;
  if (!cfgText) return;
  let cfg;
  const cfgSource = cfgText || (typeof window.FB_CONFIG === "object" ? window.FB_CONFIG : null);
  if (!cfgSource) return;
  try { cfg = typeof cfgSource === "string" ? JSON.parse(cfgSource) : cfgSource; }
  catch { if (!quiet) toast("Конфиг Firebase повреждён — вставьте заново", true); return; }
  try {
    if (!fbModules) {
      const base = "https://www.gstatic.com/firebasejs/10.12.2/";
      const [appMod, authMod, dbMod] = await Promise.all([
        import(base + "firebase-app.js"),
        import(base + "firebase-auth.js"),
        import(base + "firebase-firestore.js")
      ]);
      fbModules = { appMod, authMod, dbMod };
    }
    const { appMod, authMod, dbMod } = fbModules;
    if (!fbApp) {
      fbApp = appMod.initializeApp(cfg);
      fbAuth = authMod.getAuth(fbApp);
      fbDb = dbMod.getFirestore(fbApp);
      authMod.onAuthStateChanged(fbAuth, async u => {
        const prev = fbUser;
        fbUser = u;
        if (u) {
          // вход: переключаемся на аккаунтное хранилище, тянем облако, объединяем
          const guestRaw = store.getItem(STORAGE_KEY);
          const guestData = guestRaw ? JSON.parse(guestRaw) : null;
          ACCOUNT_KEY = "healthDiary.v2:" + u.uid;
          const localRaw = store.getItem(ACCOUNT_KEY);
          data = loadData();
          if (localRaw) { await syncPull(true); }
          else if (guestData && (guestData.foods || []).length) {
            // первое вход на устройстве: миграция гостевых данных в аккаунт
            mergeCloud(guestData);
            persist();
            await syncPull(true);
            toast("Локальные записи перенесены в аккаунт");
          } else {
            await syncPull(true);
          }
          renderAll();
        } else if (prev) {
          // выход: возвращаемся к гостевому хранилищу
          ACCOUNT_KEY = null;
          data = loadData();
          renderAll();
        }
        renderSyncSection();
      });
    }
  } catch (e) {
    syncState = { ok: false, err: true, msg: "Ошибка Firebase: " + e.message };
    renderSyncSection();
  }
}

function authErrText(code) {
  const map = {
    "auth/invalid-credential": "Неверная почта или пароль",
    "auth/wrong-password": "Неверная почта или пароль",
    "auth/user-not-found": "Аккаунт с такой почтой не найден — зарегистрируйтесь",
    "auth/email-already-in-use": "Аккаунт с такой почтой уже есть — войдите",
    "auth/weak-password": "Пароль слишком короткий (минимум 6 символов)",
    "auth/invalid-email": "Некорректная почта",
    "auth/too-many-requests": "Слишком много попыток — подождите минуту",
    "auth/api-key-not-valid.-please-pass-a-valid-api-key": "Неверный конфиг Firebase — пройдите шаги инструкции заново",
    "auth/network-request-failed": "Нет соединения — проверьте интернет",
    "auth/operation-not-allowed": "В Firebase не включён вход Email/Password — см. шаг 2 инструкции"
  };
  if (map[code]) return map[code];
  if (/api-key/.test(code)) return "Неверный конфиг Firebase — пройдите шаги инструкции заново";
  return code;
}
function openEmailAuth() {
  openModal(`
    <div class="modal-head"><h3>Вход по почте</h3><button class="close-x" data-action="closeModal">✕</button></div>
    <p class="hint" style="margin:0 0 10px">Регистрация прямо в приложении. Почта нужна только как имя аккаунта — никаких писем не приходит.</p>
    <label class="field">Почта<input id="eaEmail" type="email" placeholder="vasha.pochta@gmail.com" autocomplete="email"></label>
    <label class="field" style="margin-top:8px">Пароль (минимум 6 символов)<input id="eaPass" type="password" placeholder="••••••" autocomplete="current-password"></label>
    <div class="btn-row">
      <button data-action="emailSignIn">Войти</button>
      <button class="ghost" data-action="emailSignUp">Создать аккаунт</button>
    </div>
    <div id="eaErr" class="hint" style="color:var(--danger)"></div>
  `, { center: true });
  $("#eaPass").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); emailSignIn(); } });
}
async function emailSignIn() {
  if (!fbAuth) { await initFirebase(); if (!fbAuth) { $("#eaErr").textContent = "Сначала сохраните конфиг Firebase в настройках"; return; } }
  const email = $("#eaEmail").value.trim(), pass = $("#eaPass").value;
  try {
    await fbModules.authMod.signInWithEmailAndPassword(fbAuth, email, pass);
    closeModal();
  } catch (e) { $("#eaErr").textContent = authErrText(e.code || e.message); }
}
async function emailSignUp() {
  if (!fbAuth) { await initFirebase(); if (!fbAuth) { $("#eaErr").textContent = "Сначала сохраните конфиг Firebase в настройках"; return; } }
  const email = $("#eaEmail").value.trim(), pass = $("#eaPass").value;
  if (pass.length < 6) { $("#eaErr").textContent = "Пароль слишком короткий (минимум 6 символов)"; return; }
  try {
    await fbModules.authMod.createUserWithEmailAndPassword(fbAuth, email, pass);
    closeModal();
    toast("Аккаунт создан");
  } catch (e) { $("#eaErr").textContent = authErrText(e.code || e.message); }
}
async function googleLogin() {
  if (!fbAuth) { await initFirebase(); if (!fbAuth) { toast("Сначала сохраните корректный конфиг Firebase", true); return; } }
  const provider = new fbModules.authMod.GoogleAuthProvider();
  try {
    await fbModules.authMod.signInWithPopup(fbAuth, provider);
    toast("Вы вошли через Google");
  } catch (e) {
    if (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-this-environment") {
      try { await fbModules.authMod.signInWithRedirect(fbAuth, provider); } catch (e2) { toast("Вход не удался: " + e2.message, true); }
    } else toast("Вход не удался: " + (e.code || e.message), true);
  }
}
async function googleLogout() {
  if (fbAuth) await fbAuth.signOut();
  fbUser = null;
  renderSyncSection();
}

function mergeCloud(cloud) {
  // слияние по id: новее побеждает; удаления (tombstones) применяются
  const dels = Object.assign({}, cloud.del || {});
  const newer = (a, b) => ((b && b.u) || 0) > ((a && a.u) || 0) ? b : a;
  const mergeArr = (a, b) => {
    const map = new Map();
    for (const x of a) if (x && x.id) map.set(x.id, x);
    for (const x of b || []) if (x && x.id) map.set(x.id, newer(map.get(x.id), x));
    let out = [...map.values()];
    if (Object.keys(dels).length) out = out.filter(x => !dels[x.id] || (x.u || 0) > dels[x.id]);
    return out;
  };
  data.foods = mergeArr(data.foods, cloud.foods || []);
  data.weights = mergeArr(data.weights, cloud.weights || []);
  data.workouts = mergeArr(data.workouts, cloud.workouts || []);
  data.customFoods = mergeArr(data.customFoods, cloud.customFoods || []);
  data.plans = mergeArr(data.plans, cloud.plans || []);
  data.mealPlan = data.mealPlan || {};
  for (const [d, items] of Object.entries(cloud.mealPlan || {})) {
    data.mealPlan[d] = mergeArr(data.mealPlan[d] || [], items);
  }
  if (cloud.settings) {
    const cs = { ...cloud.settings };
    delete cs.openaiKey; delete cs.geminiKey; delete cs.firebaseConfig; // секреты не синхронизируем
    for (const k of Object.keys(cs)) {
      const lv = data.settings[k], cv = cs[k];
      const isUndef = lv === undefined || lv === null || lv === "" || (Array.isArray(lv) && !lv.length);
      if (isUndef && cv !== undefined) data.settings[k] = cv;
    }
  }
  purgeTombstones();
}

async function syncPush(silent) {
  if (!fbUser || !fbDb) return;
  syncState = { ok: false, err: false, msg: "Сохранение в облако…" };
  renderSyncSection();
  try {
    const { doc, setDoc } = fbModules.dbMod;
    const payload = JSON.parse(JSON.stringify(data));
    payload.settings = { ...payload.settings, geminiKey: "", openaiKey: "", firebaseConfig: "" }; // секреты не покидают устройство
    await setDoc(doc(fbDb, "users", fbUser.uid), { data: JSON.stringify(payload), syncedAt: Date.now() });
    syncState = { ok: true, err: false, msg: "Синхронизировано " + new Date().toLocaleTimeString("ru-RU") };
    renderSyncSection();
    if (!silent) toast("Сохранено в облако");
  } catch (e) {
    syncState = { ok: false, err: true, msg: "Ошибка: " + e.message };
    renderSyncSection();
    if (!silent) toast("Ошибка сохранения: " + e.message, true);
  }
}

async function syncPull(silent) {
  if (!fbUser || !fbDb) return;
  syncState = { ok: false, err: false, msg: "Загрузка из облака…" };
  renderSyncSection();
  try {
    const { doc, getDoc } = fbModules.dbMod;
    const snap = await getDoc(doc(fbDb, "users", fbUser.uid));
    if (!snap.exists()) { toast("В облаке пока ничего нет — нажмите «Сохранить в облако»", true); syncState = { ok: true, err: false, msg: "В облаке пусто" }; renderSyncSection(); return; }
    const cloud = JSON.parse(snap.data().data);
    mergeCloud(cloud);
    persist();
    renderAll();
    syncState = { ok: true, err: false, msg: "Загружено " + new Date().toLocaleTimeString("ru-RU") };
    renderSyncSection();
    toast("Загружено из облака (данные объединены)");
  } catch (e) {
    syncState = { ok: false, err: true, msg: "Ошибка: " + e.message };
    renderSyncSection();
    if (!silent) toast("Ошибка загрузки: " + e.message, true);
  }
}

function scheduleAutoSync() {
  if (!data.settings.autoSync || !fbUser) return;
  clearTimeout(pendingSaveSync);
  pendingSaveSync = setTimeout(() => syncPush(true), 3000);
}

/* ================= ДЕЙСТВИЯ ================= */
const actions = {
  prevDay: () => { selectedDate = shiftDate(selectedDate, -1); renderAll(); },
  nextDay: () => { selectedDate = shiftDate(selectedDate, 1); renderAll(); },
  today: () => { selectedDate = todayStr(); renderAll(); },
  addFood: (el) => { openFoodSearch(el.dataset.meal || "Обед", el.dataset.target === "plan" ? "plan" : "diary"); },
  manualEntry: () => showAddManually(),
  photoFood: () => { openFoodSearch(null, "diary", "photo"); },
  voiceFood: () => openVoice(),
  barcodeFood: () => { openFoodSearch(null, "diary", "barcode"); },
  closeModal: () => closeModal(),
  restToggle: () => restToggle(),
  restReset: () => restReset(),
  backToSearch: () => openFoodSearch(foodSearchCtx.meal, foodSearchCtx.target),
  pickFood: (el) => { openPortionEditor(JSON.parse(el.dataset.json), el.dataset.grams ? +el.dataset.grams : null); },
  confirmPortion: (el) => confirmPortion(JSON.parse(el.dataset.item)),
  editFood: (el) => editFood(el.dataset.id),
  saveEditFood: (el) => saveEditFood(el.dataset.id),
  exProgress: (el) => openExProgress(el.dataset.name),  saveManualFood: () => saveManualFood(),
  delFood: (el) => { data.foods = data.foods.filter(x => x.id !== el.dataset.id); tombstone(el.dataset.id); refresh(); },
  delWorkout: (el) => { data.workouts = data.workouts.filter(x => x.id !== el.dataset.id); tombstone(el.dataset.id); refresh(); },
  delWeight: (el) => { data.weights = data.weights.filter(x => x.id !== el.dataset.id); tombstone(el.dataset.id); refresh(); },
  showLoadDetail: (el) => showLoadDetailModal(el.dataset.name),
  copyYesterday: () => copyYesterday(),
  repeatMeal: (el) => repeatMeal(el.dataset.meal),
  copyMeal: (el) => copyMeal(el.dataset.date),
  showAddManually: () => showAddManually(),
  saveMealAsDish: (el) => saveMealAsDish(el.dataset.meal),
  newCustomFood: () => newCustomFood(),
  saveCustomFood: (el) => saveCustomFood(el.dataset.id || ""),
  lookupBarcode: () => doBarcodeLookup($("#barcodeInput").value.trim()),
  startScan: () => startScan(),
  toggleMic: () => { },
  searchVoiceItem: (el) => searchVoiceItem(+el.dataset.i),
  addVoiceItems: () => addVoiceItems(),
  newPlan: () => openPlanEditor(null),
  editPlan: (el) => openPlanEditor(data.plans.find(p => p.id === el.dataset.id)),
  delPlan: (el) => {
    const p = data.plans.find(x => x.id === el.dataset.id);
    if (p && confirm(`Удалить план «${p.name}»?`)) { data.plans = data.plans.filter(x => x.id !== el.dataset.id); tombstone(el.dataset.id); refresh(); }
  },
  startPlan: (el) => openTrainingSession(el.dataset.id),
  resumeWorkout: (el) => renderTrainingSession(el.dataset.id),
  addSet: (el) => addSetBtn(el.dataset.id, +el.dataset.i),
  repeatSet: (el) => {
    const w = data.workouts.find(x => x.id === el.dataset.id);
    const i = +el.dataset.i;
    if (!w || !w.exercises || !w.exercises[i]) return;
    const ex = w.exercises[i];
    if (ex.sets.length === 0) { toast("Нет выполненных подходов для повторения", true); return; }
    const last = ex.sets[ex.sets.length - 1];
    const wInput = $(`.ts-w[data-i="${i}"]`);
    const rInput = $(`.ts-r[data-i="${i}"]`);
    if (wInput) wInput.value = last.weight != null ? last.weight : "";
    if (rInput) rInput.value = last.reps;
  },
  editSet: (el) => {
    const w = data.workouts.find(x => x.id === el.dataset.id);
    const i = +el.dataset.i, j = +el.dataset.j;
    if (!w || !w.exercises || !w.exercises[i] || !w.exercises[i].sets[j]) return;
    const s = w.exercises[i].sets[j];
    const wPrompt = prompt("Вес (кг):", s.weight != null ? s.weight : "");
    if (wPrompt === null) return;
    const rPrompt = prompt("Повторы:", s.reps);
    if (rPrompt === null) return;
    w.exercises[i].sets[j] = { weight: wPrompt === "" ? null : num(wPrompt), reps: rPrompt.trim(), toFailure: s.toFailure };
    touch(w); persist(); renderTrainingSession(w.id);
  },
  toggleSuperset: (el) => {
    const w = data.workouts.find(x => x.id === el.dataset.id);
    const i = +el.dataset.i;
    if (!w || !w.exercises || !w.exercises[i]) return;
    const ex = w.exercises[i];
    if (ex.ssGroup) {
      delete ex.ssGroup;
    } else {
      // Если предыдущее упражнение уже в суперсете — добавляем его в ту же группу
      const prev = w.exercises[i - 1];
      if (prev && prev.ssGroup) {
        ex.ssGroup = prev.ssGroup;
      } else {
        // Новая группа — создаём уникальное значение на основе индекса
        // Нормализация в renderTrainingSession переназначит это на 1, 2, 3...
        ex.ssGroup = 'ss-' + i;
      }
    }
    touch(w); persist(); renderTrainingSession(w.id);
  },
  toggleProgressHint: (el) => {
    const w = data.workouts.find(x => x.id === el.dataset.id);
    const i = +el.dataset.i;
    if (!w || !w.exercises || !w.exercises[i]) return;
    const ex = w.exercises[i];
    const exName = normExName(ex.name);
    if (!data.settings.skipProgressHint) data.settings.skipProgressHint = [];
    const idx = data.settings.skipProgressHint.indexOf(exName);
    if (idx > -1) {
      data.settings.skipProgressHint.splice(idx, 1);
      toast(`Рекомендация веса для «${ex.name}» включена`);
    } else {
      data.settings.skipProgressHint.push(exName);
      toast(`Рекомендация веса для «${ex.name}» отключена`);
    }
    persist();
    renderTrainingSession(w.id);
  },
  delSet: (el) => {
    const w = data.workouts.find(x => x.id === el.dataset.id);
    if (w && w.exercises && w.exercises[+el.dataset.i]) {
      w.exercises[+el.dataset.i].sets.splice(+el.dataset.j, 1);
      touch(w); persist(); renderTrainingSession(w.id);
    }
  },
  editSet: (el) => {
    const w = data.workouts.find(x => x.id === el.dataset.id);
    const i = +el.dataset.i, j = +el.dataset.j;
    if (!w || !w.exercises || !w.exercises[i] || !w.exercises[i].sets[j]) return;
    const s = w.exercises[i].sets[j];
    const weight = prompt("Вес (кг):", s.weight != null ? s.weight : "");
    const reps = prompt("Повторы:", s.reps);
    if (weight === null || reps === null) return;
    w.exercises[i].sets[j] = { weight: weight === "" ? null : num(weight), reps: reps.trim(), toFailure: s.toFailure };
    touch(w); persist(); renderTrainingSession(w.id);
  },
  repeatSet: (el) => {
    const w = data.workouts.find(x => x.id === el.dataset.id);
    const i = +el.dataset.i;
    if (!w || !w.exercises || !w.exercises[i]) return;
    const ex = w.exercises[i];
    if (ex.sets.length === 0) { toast("Нет выполненных подходов для повторения", true); return; }
    const last = ex.sets[ex.sets.length - 1];
    $(`.ts-w[data-i="${i}"]`).value = last.weight != null ? last.weight : "";
    $(`.ts-r[data-i="${i}"]`).value = last.reps;
  },
  delSessionEx: (el) => {
    const w = data.workouts.find(x => x.id === el.dataset.id);
    if (w && w.exercises && w.exercises[+el.dataset.i]) {
      w.exercises.splice(+el.dataset.i, 1);
      touch(w); persist(); renderTrainingSession(w.id);
    }
  },
  addSessionEx: (el) => {
    const name = prompt("Название упражнения:");
    if (!name || !name.trim()) return;
    const w = data.workouts.find(x => x.id === el.dataset.id);
    if (!w) return;
    w.exercises = workoutExercises(w);
    w.exercises.push({ name: name.trim(), sets: [] });
    touch(w); persist(); renderTrainingSession(w.id);
  },
  finishWorkout: (el) => finishWorkout(el.dataset.id),
  closeSession: () => { restReset(); closeModal(); renderWorkouts(); },
  newRecipe: () => openRecipeBuilder(null),
  progSwitch: (el) => progSwitch(el.dataset.tab),
  loadPick: (el) => { const sel = $("#loadEx"); if (sel) { sel.value = el.dataset.name; drawLoadDetail(el.dataset.name); } },
  editRecipe: (el) => openRecipeBuilder(data.customFoods.find(c => c.id === el.dataset.id)),
  editCustomFood: (el) => newCustomFood(data.customFoods.find(c => c.id === el.dataset.id)),
  delCustomFood: (el) => {
    const c = data.customFoods.find(x => x.id === el.dataset.id);
    if (!c) return;
    if (!confirm(`Удалить блюдо «${c.name}» из «Моих блюд»? Записи в дневнике за прошлые дни останутся.`)) return;
    data.customFoods = data.customFoods.filter(x => x.id !== c.id);
    tombstone(c.id);
    refresh();
    if ($("#customList")) renderFoodSearch("custom");
  },
  recipePick: (el) => {
    const x = JSON.parse(el.dataset.json);
    recipeCtx.items.push({ name: x.name, grams: 100, cal: num(x.cal), p: num(x.p), f: num(x.f), c: num(x.c), autoCal: false });
    renderRecipeItems();
  },
  recipeAddManual: () => {
    recipeCtx.items.push({ name: "", grams: 100, cal: 0, p: 0, f: 0, c: 0, autoCal: true });
    renderRecipeItems();
  },
  recipeDelItem: (el) => {
    recipeCtx.items.splice(+el.dataset.i, 1);
    renderRecipeItems();
  },
  saveRecipe: () => saveRecipe(),
  loadSamplePlans: () => loadSamplePlans(),
  addWeightNow: () => { switchTab("diary"); setTimeout(() => $("[data-form=weight] input").focus(), 100); },
  gotoProgress: () => switchTab("progress"),
  delTopFood: (el) => {
    const name = el.dataset.name;
    const n = data.foods.filter(f => f.name === name).length;
    if (!n) return;
    if (!confirm(`Удалить все записи «${name}» из дневника (${n} шт)? Это необратимо.`)) return;
    data.foods.forEach(f => { if (f.name === name) tombstone(f.id); });
    data.foods = data.foods.filter(f => f.name !== name);
    refresh();
    toast(`Удалено: «${name}» — ${n} ${plural(n, "запись", "записи", "записей")}`);
  },
  hideRecord: (el) => {
    const name = el.dataset.name;
    if (!confirm(`Скрыть «${name}» из рекордов? Сами записи тренировок останутся нетронутыми.`)) return;
    data.settings.hiddenRecs = (data.settings.hiddenRecs || []).concat(name);
    persist(); renderRecords();
  },
  showHiddenRecords: () => {
    data.settings.hiddenRecs = [];
    persist(); renderRecords();
    toast("Скрытые рекорды снова показаны");
  },
  calcTargets: () => {
    const wt = sortedWeights();
    const kg = wt.length ? wt[wt.length - 1].kg : 0;
    const sex = $("#calSex").value, h = num($("#calHeight").value), a = num($("#calAge").value);
    if (!kg) { toast("Сначала запиши вес — он нужен для расчёта", true); return; }
    if (!h || !a) { toast("Укажи рост и возраст", true); return; }
    const bmr = 10 * kg + 6.25 * h - 5 * a + (sex === "ж" ? -161 : 5);
    const mode = $("#calMode").value;
    const mult = mode === "deficit" ? 0.85 : mode === "surplus" ? 1.1 : 1;
    const target = Math.max(800, Math.round(bmr * 1.375 * mult));
    const p = Math.round(kg * 1.8), f = Math.round(kg * 1);
    const c = Math.max(0, Math.round((target - 4 * p - 9 * f) / 4));
    data.settings.sex = sex; data.settings.height = h; data.settings.age = a; data.settings.mode = mode;
    data.settings.goalCal = target; data.settings.goalP = p; data.settings.goalF = f; data.settings.goalC = c;
    persist(); refresh();
    toast(`Цель: ${target} ккал · Б ${p} · Ж ${f} · У ${c} (${mode === "deficit" ? "дефицит −15%" : mode === "surplus" ? "профицит +10%" : "поддержание"})`);
  },
  copyPlanToDiary: () => copyPlanToDiary(),
  applyBalanced: () => applyTemplate("balanced"),
  applyProtein: () => applyTemplate("protein"),
  clearPlan: () => {
    if (!confirm("Очистить план питания на этот день?")) return;
    delete data.mealPlan[selectedDate]; refresh();
  },
  delPlanItem: (el) => {
    data.mealPlan[selectedDate] = (data.mealPlan[selectedDate] || []).filter(x => x.id !== el.dataset.id);
    tombstone(el.dataset.id);
    refresh();
  },
  delMealName: (el) => {
    if (data.settings.mealNames.length <= 1) { toast("Должен остаться хотя бы один приём пищи", true); return; }
    const i = +el.dataset.i;
    const name = data.settings.mealNames[i];
    const rest = data.settings.mealNames.filter((_, j) => j !== i);
    const affected = data.foods.filter(f => f.meal === name).length + (data.mealPlan[selectedDate] || []).filter(f => f.meal === name).length;
    if (affected && !confirm(`У приёма «${name}» есть записи (${affected}). Перенести их на «${rest[0]}»?`)) return;
    if (affected) {
      data.foods.forEach(f => { if (f.meal === name) { f.meal = rest[0]; touch(f); } });
      Object.values(data.mealPlan).forEach(items => items.forEach(f => { if (f.meal === name) { f.meal = rest[0]; touch(f); } }));
    }
    data.settings.mealNames.splice(i, 1);
    refresh();
  },
  saveFbConfig: async () => {
    const raw = $("#fbConfig").value.trim();
    try { JSON.parse(raw); } catch { toast("Это не похоже на конфиг — вставьте объект firebaseConfig целиком", true); return; }
    data.settings.firebaseConfig = raw;
    persist();
    await initFirebase();
    if (fbAuth) renderSyncSection();
    toast("Конфиг Firebase сохранён");
  },
  resetFbConfig: () => { data.settings.firebaseConfig = ""; persist(); renderSyncSection(); },
  googleLogin: () => googleLogin(),
  emailLogin: () => openEmailAuth(),
  emailSignIn: () => emailSignIn(),
  emailSignUp: () => emailSignUp(),
  googleLogout: () => googleLogout(),
  syncPush: () => syncPush(false),
  syncPull: () => syncPull(),
  installPwa: async () => {
    if (installPromptEvent) { installPromptEvent.prompt(); const r = await installPromptEvent.userChoice; if (r.outcome === "accepted") toast("Устанавливаем…"); }
  },
  exportData: () => {
    const payload = JSON.parse(JSON.stringify(data));
    payload.settings = { ...payload.settings, geminiKey: "", openaiKey: "", firebaseConfig: "" }; // ключи в экспорт не включаем
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `dnevnik-zdorovia-${todayStr()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast("Файл с данными скачан");
  },
  exportCsv: () => {
    const csv = buildCsvRows(data);
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" }); // BOM — чтобы Excel видел кириллицу
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `dnevnik-zdorovia-${todayStr()}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast("CSV для Excel скачан");
  },
  exportXls: () => {
    if (typeof XLSX === "undefined") {
      // библиотека не загрузилась — запасной HTML-.xls
      const blob = new Blob([buildXlsHtml(data)], { type: "application/vnd.ms-excel;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `dnevnik-zdorovia-${todayStr()}.xls`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast("Excel (простая версия) скачан");
      return;
    }
    const s = buildXlsxSheets(data);
    const wb = XLSX.utils.book_new();
    const mk = (name, aoa, widths) => {
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      if (widths) ws["!cols"] = widths.map(w => ({ wch: w }));
      XLSX.utils.book_append_sheet(wb, ws, name);
    };
    mk("Питание", s.foodRows, [12, 14, 30, 9, 9, 9, 9, 11]);
    mk("Тренировки", s.woutRows, [12, 22, 70, 7, 7, 10]);
    mk("Вес", s.wRows, [12, 10]);
    mk("Прогресс", s.progRows, [22, 16, 9, 9, 12, 11, 11, 12, 14]);
    XLSX.writeFile(wb, `dnevnik-zdorovia-${todayStr()}.xlsx`);
    toast("Таблица .xlsx (4 листа) скачана");
  },
  importData: () => {
    const inp = document.createElement("input");
    inp.type = "file"; inp.accept = ".json,application/json";
    inp.onchange = () => {
      const file = inp.files[0]; if (!file) return;
      const r = new FileReader();
      r.onload = () => {
        try {
          const imported = JSON.parse(r.result);
          if (!imported || typeof imported !== "object" || !("foods" in imported)) throw new Error("format");
          mergeCloud(imported);
          persist(); renderAll();
          toast("Данные импортированы");
        } catch { toast("Не удалось прочитать файл — это экспорт этого приложения?", true); }
      };
      r.readAsText(file);
    };
    inp.click();
  },
  clearData: () => {
    if (!confirm("Удалить ВСЕ данные (еда, вес, тренировки, планы)? Это необратимо.")) return;
    if (!confirm("Точно? Рекомендуем сначала сделать экспорт.")) return;
    data = defaultData();
    persist(); renderAll();
    toast("Все данные удалены");
  }
};

document.addEventListener("click", e => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const fn = actions[btn.dataset.action];
  if (fn) { e.preventDefault(); fn(btn, e); }
});

// чекбокс автосинхронизации (не кнопка)
document.addEventListener("change", e => {
  if (e.target.matches("[data-action=autoSyncChk]")) {
    data.settings.autoSync = e.target.checked;
    persist();
  }
});

// автопересчёт калорий по БЖУ в строках голосового ввода
 document.addEventListener("input", e => {
  const t = e.target;
  if (!t.classList) return;
  const pre = (t.classList.contains("vi-p") || t.classList.contains("vi-f") || t.classList.contains("vi-c")) ? "vi" : null;
  if (!pre || t.dataset.i == null) return;
  const i = t.dataset.i;
  const cal = document.querySelector(`.${pre}-cal[data-i="${i}"]`);
  const p = document.querySelector(`.${pre}-p[data-i="${i}"]`);
  const f = document.querySelector(`.${pre}-f[data-i="${i}"]`);
  const c = document.querySelector(`.${pre}-c[data-i="${i}"]`);
  if (cal && p && f && c) cal.value = macroCal(p.value, f.value, c.value);
});

/* формы */
document.addEventListener("submit", e => {
  const form = e.target.closest("form[data-form]");
  if (!form) return;
  e.preventDefault();
  const fd = new FormData(form);
  switch (form.dataset.form) {
    case "weight": {
      const kg = num(fd.get("kg"));
      if (!kg) { toast("Укажите вес в килограммах", true); return; }
      data.weights = data.weights.filter(w => w.date !== selectedDate);
      data.weights.push(touch({ id: uid(), date: selectedDate, kg, createdAt: Date.now() }));
      form.reset();
      refresh();
      toast("Вес сохранён");
      break;
    }
    case "workout": {
      const name = (fd.get("name") || "").trim();
      if (!name) { toast("Укажите название тренировки", true); return; }
      data.workouts.push(touch({ id: uid(), date: selectedDate, name, minutes: num(fd.get("minutes")), cal: num(fd.get("calories")), details: (fd.get("details") || "").trim() }));
      form.reset();
      refresh();
      toast("Тренировка добавлена");
      break;
    }
    case "goals": {
      data.settings.goalCal = num(fd.get("goalCal"));
      data.settings.goalP = num(fd.get("goalP"));
      data.settings.goalF = num(fd.get("goalF"));
      data.settings.goalC = num(fd.get("goalC"));
      data.settings.goalWeight = num(fd.get("goalWeight")) || null;
      if (fd.get("calSex")) data.settings.sex = fd.get("calSex");
      data.settings.height = num(fd.get("calHeight"));
      data.settings.age = num(fd.get("calAge"));
      if (fd.get("calMode") !== null) data.settings.mode = fd.get("calMode") || "";
      refresh();
      toast("Цели сохранены");
      break;
    }
    case "addMealName": {
      const n = (fd.get("mealName") || "").trim();
      if (!n) return;
      if (data.settings.mealNames.length >= 10) { toast("Максимум 10 приёмов пищи", true); return; }
      data.settings.mealNames.push(n);
      form.reset();
      refresh();
      break;
    }
  }
});

// переключение вкладок
$$(".tabbar button").forEach(b => b.addEventListener("click", () => switchTab(b.dataset.tab)));

// даты
["dateInput", "dateInputW", "dateInputP"].forEach(id => {
  const el = document.getElementById(id);
  el.addEventListener("change", () => { selectedDate = el.value || todayStr(); renderAll(); });
});

/* ================= PWA ================= */
let installPromptEvent = null;
window.addEventListener("beforeinstallprompt", e => {
  e.preventDefault();
  installPromptEvent = e;
  const btn = $("#installBtn");
  if (btn) btn.hidden = false;
  renderInstallGuide();
});
document.getElementById("installBtn").addEventListener("click", () => {
  if (installPromptEvent) installPromptEvent.prompt().catch(() => {});
});
window.addEventListener("appinstalled", () => {
  $("#installBtn").hidden = true;
  installPromptEvent = null;
  toast("Приложение установлено");
});

try {
  if (navigator.serviceWorker) {
    window.addEventListener("load", () => {
      try { navigator.serviceWorker.register("sw.js").catch(() => { /* офлайн недоступен — ок */ }); } catch { /* песочница — ок */ }
    });
    // при обновлении service worker перезагружаем страницу один раз, чтобы не застревать на старой версии
    let swReloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (swReloaded) return;
      swReloaded = true;
      window.location.reload();
    });
  }
} catch { /* песочница предпросмотра: service worker недоступен — ок */ }

/* индикатор сети */
function updateSyncDot() {
  const dot = $("#syncDot");
  if (!dot) return;
  if (fbUser) dot.className = "sync-dot" + (syncState.ok ? " on" : syncState.err ? " err" : "");
  else dot.className = "sync-dot";
}
const _origRenderSync = renderSyncSection;
renderSyncSection = function () { _origRenderSync(); updateSyncDot(); };

/* ================= ОНБОРДИНГ (первый запуск) ================= */
const ONBOARD_STEPS = [
  { img: "art/card-food.png", title: "Веди дневник", text: "Записывай еду по КБЖУ: поиск, голос, штрихкод и быстрый ввод. Цели и план питания — в одном месте." },
  { img: "art/card-strength.png", title: "Тренируйся", text: "Свои планы, живая запись подходов, таймер отдыха, суперсеты и заметки к упражнениям." },
  { img: "art/card-progress.png", title: "Смотри прогресс", text: "Графики веса и калорий, прогноз цели, рекорды, объёмы по группам мышц и сводка за всё время." }
];

function openOnboarding() {
  let step = 0;
  const draw = () => {
    const s = ONBOARD_STEPS[step];
    const last = step === ONBOARD_STEPS.length - 1;
    openModal(`
      <div class="onboard">
        <img class="onboard-img" src="${s.img}" alt="">
        <div class="onboard-title">${esc(s.title)}</div>
        <div class="onboard-text">${esc(s.text)}</div>
        <div class="onboard-dots">${ONBOARD_STEPS.map((_, i) => `<span class="${i === step ? "on" : ""}"></span>`).join("")}</div>
        <div class="btn-row">
          ${step > 0 ? `<button class="ghost" data-action="onboardPrev">Назад</button>` : ""}
          <button data-action="onboardNext">${last ? "Начать 💪" : "Далее"}</button>
          ${!last ? `<button class="ghost" data-action="onboardDone">Пропустить</button>` : ""}
        </div>
      </div>`, { center: true });
  };
  draw();
  actions.onboardNext = () => {
    step++;
    if (step >= ONBOARD_STEPS.length) return actions.onboardDone();
    draw();
  };
  actions.onboardPrev = () => { if (step > 0) { step--; draw(); } };
  actions.onboardDone = function onboardDone() {
    try { store.setItem("dnevnik.onboarded", "1"); } catch {}
    delete actions.onboardNext; delete actions.onboardPrev; delete actions.onboardDone;
    closeModal();
  };
}

function maybeOnboard() {
  try { if (store.getItem("dnevnik.onboarded")) return; } catch {}
  setTimeout(openOnboarding, 400); // даём странице отрисоваться
}

/* ================= СТАРТ ================= */
window.addEventListener("online", () => { if (fbUser && data.settings.autoSync) syncPush(true); });
if (data.settings.firebaseConfig || (typeof window.FB_CONFIG === "object" && window.FB_CONFIG)) initFirebase(true);
// если данные мигрированы из v1 — сразу сохраняем в новый ключ
if (!store.getItem(STORAGE_KEY) && store.getItem(OLD_KEY)) persist();
switchTab("diary");
maybeOnboard();
