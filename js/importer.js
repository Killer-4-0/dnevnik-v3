/* ================= ИМПОРТ СТАРОГО ТЕКСТОВОГО ДНЕВНИКА ================= */
/* Разбирает текст вида:
   тренировки:2 ноября грудь трицепс
   1. Жим лёжа 70 кг 4 раза+85 кг 4 раза+90 кг 1 раз
   На данный момент Вес 89,4
   ...
   ,подсчет:17 июня
   Утром пицца: лёгкий сыр 180 грамм (на 100 31 б, 18 ж), 200 грамм вареной колбасы
   Итого: Белки ≈178 г ...
*/
const IMP_MONTHS = { "январ": 1, "феврал": 2, "март": 3, "апрел": 4, "май": 5, "июн": 6, "июл": 7, "август": 8, "сентябр": 9, "октябр": 10, "ноябр": 11, "декабр": 12 };
const IMP_MEALS = { "утром": "Завтрак", "днём": "Обед", "днем": "Обед", "вечером": "Ужин", "вечер": "Ужин", "ночью": "Перекус" };
const IMP_MEAL_KEYS = Object.keys(IMP_MEALS);
// «вареной колбасы» → «колбаса» для поиска в базе (\w не знает кириллицу — поэтому [а-яё]*)
const IMP_MODIFIERS = /^(варен[а-яё]*|варён[а-яё]*|отварн[а-яё]*|свеж[а-яё]*|маринованн[а-яё]*|жарен[а-яё]*|копчен[а-яё]*|копчён[а-яё]*|обезжиренн[а-яё]*|легк[а-яё]*|домашн[а-яё]*|сырн[а-яё]*|светл[а-яё]*|обычн[а-яё]*|немного|кусочек)\s+/i;

function impNormNums(s) { return String(s).replace(/(\d),(\s)?(\d)/g, (m, a, sp, b) => a + "." + b); }
function impMonth(w) {
  const lower = w.toLowerCase();
  let key = null;
  for (const k of Object.keys(IMP_MONTHS)) if (lower.startsWith(k)) key = k; // последний (по длине) выигрывает
  return key ? IMP_MONTHS[key] : null;
}
function impToDate(day, monthWord, year) {
  const m = impMonth(monthWord);
  if (!m) return null;
  return String(year) + "-" + String(m).padStart(2, "0") + "-" + String(day).padStart(2, "0");
}

// Разбивка на блоки: дата может быть в начале строки («2 ноября…») или встроена («вес 90,5 ,подсчет:17 июня»)
function impSplitBlocks(text) {
  const blocks = [];
  let cur = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    const dm = line.match(/^(\d{1,2})\s+([а-яё]+)/i) || line.match(/(?:^|[\s,:])(\d{1,2})\s+([а-яё]+)/i);
    if (dm && impToDate(dm[1], dm[2], 2000)) {
      const before = line.slice(0, dm.index);
      const rest = line.slice(dm.index + dm[0].length).trim();
      if (before.trim() && cur) cur.lines.push(before.trim()); // «вес 90,5 ,подсчет:» остаётся в старом блоке
      cur = { day: +dm[1], monthWord: dm[2], rest, lines: [] };
      blocks.push(cur);
      continue;
    }
    if (cur) cur.lines.push(line);
  }
  return blocks;
}

function impParseWorkoutBlock(b) {
  const w = { name: b.rest, exercises: [] };
  let weight = null;
  for (const raw of b.lines) {
    const line = impNormNums(raw).trim();
    if (/на данный момент/i.test(line)) {
      const wm = line.match(/(\d{1,3}(?:\.\d{1,2})?)\s*(?:кг)?/i);
      if (wm) weight = parseFloat(wm[1]);
      continue;
    }
    // новый формат Дипсика: «Вес: 76,3 кг.»
    const wmW = line.match(/^вес\s*[:—–-]?\s*(\d{1,3}(?:\.\d{1,2})?)/i);
    if (wmW) { weight = parseFloat(wmW[1]); continue; }
    let name = "", setsPart = "";
    const em = line.match(/^\d+[.)]\s*(.+)$/);
    if (em) {
      // старый формат: «1. Жим лёжа 70 кг 4 раза+…» — название до первого числа
      const rest = em[1];
      const numIdx = rest.search(/\s\d/);
      name = (numIdx >= 0 ? rest.slice(0, numIdx) : rest).trim();
      setsPart = rest.slice(numIdx >= 0 ? numIdx : 0);
    } else {
      // формат Дипсика: «Подтягивания: 15 + 17 + 12.» — название до двоеточия
      const cm = line.match(/^([^:+]+):\s*(.+)$/);
      if (cm && cm[2].trim()) { name = cm[1].trim(); setsPart = cm[2]; }
    }
    if (!name) continue;
    const sets = [];
    for (const part of setsPart.split("+")) {
      const p = part.trim();
      if (!p || /не получились|неполуч|не вышло/i.test(p) && p.indexOf("кг") < 0) continue; // «2 попытки пожать 100 кг не получились» — без числа-сета
      const wm = p.match(/^(\d{1,3}(?:\.\d{1,2})?)\s*кг\s*(?:на\s*|×\s*|[xх]\s*)?(\d{1,3}(?:\.\d{1,2})?)?\s*(?:раз[а-яё]*|повтор[а-яё]*|[рр]\b)?/i);
      const rm = !wm && p.match(/^(\d{1,3}(?:\.\d{1,2})?)\s*(мин|сек|раз[а-яё]*|повтор[а-яё]*|[рр]\b)?/i);
      if (wm) sets.push({ weight: parseFloat(wm[1]), reps: wm[2] ? String(parseFloat(wm[2])) : "" });
      else if (rm) sets.push({ weight: null, reps: (rm[1] + (rm[2] ? " " + rm[2] : "")).trim() });
      // примечания («с паузой», «с помощью») игнорируем
    }
    w.exercises.push({ name, sets });
  }
  return { workout: w, weight };
}

/* ---------- Еда ---------- */
function impParseKbju(text) {
  // «31 б, 18 ж» / «8 б, 7ж, 48 у» / «12 у» — числа с буквами или по порядку б,ж,у
  const parts = [...text.matchAll(/(\d{1,3}(?:[.,]\d{1,2})?)\s*([бжуп]?)/gi)].map(m => ({ v: parseFloat(m[1].replace(",", ".")), k: (m[2] || "").toLowerCase() }));
  const out = { p: 0, f: 0, c: 0 };
  const order = ["p", "f", "c"];
  let i = 0;
  for (const pt of parts) {
    const key = pt.k === "б" ? "p" : pt.k === "ж" ? "f" : pt.k === "у" ? "c" : order[i++];
    if (key) out[key] = pt.v;
  }
  return out;
}
function impCleanFoodName(n) {
  let s = n.replace(IMP_MODIFIERS, "");
  s = s.replace(IMP_MODIFIERS, "").replace(/-/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  return s;
}
function impFindInBase(name) {
  if (typeof findFoodMatch !== "function") return null;
  const direct = findFoodMatch(name.toLowerCase());
  if (direct) return direct;
  return findFoodMatch(impCleanFoodName(name));
}

function impParseFoodBlock(b, warnings) {
  const items = [];
  let meal = "Обед";
  for (const raw of b.lines) {
    let line = impNormNums(raw.trim());
    const mk = IMP_MEAL_KEYS.find(k => line.toLowerCase().startsWith(k));
    if (mk) {
      meal = IMP_MEALS[mk];
      line = line.slice(mk.length).replace(/^[,:\s]+/, ""); // «Утром …» — маркер приёма, продукты дальше в строке
    }
    if (/^итого|^белки|^жиры|^углев|^калор|\u2248|^\s*$/i.test(line)) continue;
    // скобки с КБЖУ вырезаем, чтобы запятые внутри не резали список
    const parens = [];
    const noParens = line.replace(/\(([^)]*)\)/g, (m, inner) => { parens.push(inner); return "\u0001"; });
    let pi = 0;
    for (const ch of noParens.split(",").map(s => s.trim()).filter(Boolean)) {
      const kbjuText = ch.includes("\u0001") ? parens[pi++] : null;
      const norm = ch.replace(/\u0001/g, "").replace(/~/g, "").trim();
      // «легкий сыр 180 грамм», «400 грамм творога», «450 мл энергетик», «1 литр pulpy», «примерно грамм 200»
      let mm = norm.match(/(\d{1,4}(?:\.\d{1,2})?)\s*(грамм\w*|гр|г\b|мл|литр\w*)/i);
      let reversed = false;
      if (!mm) { mm = norm.match(/(грамм\w*|гр|г\b|мл|литр\w*)\s*(\d{1,4}(?:\.\d{1,2})?)/i) ; if (mm) reversed = true; }
      if (!mm) { warnings.push("пропущено (нет веса): «" + norm + "»"); continue; }
      const numStr = reversed ? mm[2] : mm[1];
      const unit = (reversed ? mm[1] : mm[2]).toLowerCase();
      const before = norm.slice(0, mm.index).trim();
      const after = norm.slice(mm.index + mm[0].length).trim();
      const name = (before || after).replace(/^[,:\s]+|[,:\s\u0001]+$/g, "").replace(/\s+примерно\s*$/i, "").trim();
      if (!name) { warnings.push("пропущено (не имя): «" + norm + "»"); continue; }
      const qty = parseFloat(numStr);
      const grams = /^литр/.test(unit) ? Math.round(qty * 1000) : Math.round(qty);
      const kbju = kbjuText ? impParseKbju(kbjuText.replace(/^на\s*100\s*/i, "")) : null; // «на 100» — не ингредиент
      let p = 0, f = 0, c = 0, cal = 0, foundBase = false;
      if (kbju && (kbju.p || kbju.f || kbju.c)) {
        p = kbju.p; f = kbju.f; c = kbju.c;
        cal = Math.round(4 * p + 9 * f + 4 * c);
      } else if (foundBase = impFindInBase(name)) {
        p = foundBase.p; f = foundBase.f; c = foundBase.c; cal = foundBase.cal;
      }
      const k = grams / 100;
      items.push({ meal, name, grams, cal: Math.round(cal * k), p: Math.round(p * k * 10) / 10, f: Math.round(f * k * 10) / 10, c: Math.round(c * k * 10) / 10, noKbju: !kbju && !foundBase });
    }
  }
  return items;
}

// year — год первой записи; autoYear: месяцы идут по порядку → год сдвигается при переходе декабрь→январь.
// wantWorkouts / wantFoods — что импортировать (можно только еду или только тренировки).
// Итоги дня от Дипсика: «24 октября — Ккал: 2004; Б: 162,8 г; Ж: 73 г; У: 198,5 г. Вес: 72,7 кг.»
function impParseTotalsBlock(b) {
  const joined = impNormNums(b.lines.join(" ") + " " + b.rest);
  const g = re => { const m = joined.match(re); return m ? parseFloat(m[1]) : null; };
  const cal = g(/ккал\s*[:=]?\s*(\d{2,5})/i);
  const p = g(/(?:^|[;,\s(])б\s*[:=]?\s*(\d{1,4}(?:\.\d{1,2})?)/i);
  const f = g(/(?:^|[;,\s(])ж\s*[:=]?\s*(\d{1,4}(?:\.\d{1,2})?)/i);
  const c = g(/(?:^|[;,\s(])у\s*[:=]?\s*(\d{1,4}(?:\.\d{1,2})?)/i);
  const kg = g(/вес\s*[:=]?\s*(\d{1,3}(?:\.\d{1,2})?)/i);
  const items = (cal != null || (p != null && f != null))
    ? [{ meal: "Итог дня", name: "Итог дня (КБЖУ)", grams: null, cal: cal || 0, p: p || 0, f: f || 0, c: c || 0, noKbju: false }]
    : [];
  return { items, weight: kg };
}

function impParseAll(text, startYear, autoYear, wantWorkouts, wantFoods) {
  const workouts = [], weights = [], foods = [];
  const warnings = [];
  let curYear = startYear, prevMonth = 0;
  for (const b of impSplitBlocks(text)) {
    const m = impMonth(b.monthWord);
    if (!m) continue;
    if (autoYear && prevMonth && m < prevMonth) curYear++; // «декабрь» → «январь» = новый год
    prevMonth = m;
    const dateIso = impToDate(b.day, b.monthWord, curYear);
    if (!dateIso) continue;
    const joined = b.lines.join(" ") + " " + b.rest;
    const isFood = /утром|днём|днем|вечером|ночью|^итого/mi.test(joined);
    // итоги дня Дипсика: есть «Ккал:» или пара «Б: … Ж: …»
    const isTotal = !isFood && (/ккал\s*[:=]|калори\s*[:=]/i.test(joined) || (/(?:^|[;,\s(])б\s*[:=]\s*[\d,]/i.test(joined) && /(?:^|[;,\s(])ж\s*[:=]\s*[\d,]/i.test(joined)));
    // блок только с весом («— данных недостаточно… Вес: 73,65»)
    const isWeightOnly = !isFood && !isTotal && /вес\s*[:=]/i.test(joined) && !/(?:×|[xх]\s*\d|кг\s*\+|\+\s*\d)/.test(joined);
    const isWorkout = !isFood && !isTotal && !isWeightOnly && (/на данный момент|^\d+[.)]/mi.test(joined) || b.rest);
    if (isFood && wantFoods) {
      const items = impParseFoodBlock(b, warnings);
      if (items.length) foods.push({ date: dateIso, items });
      continue;
    }
    if (wantFoods && (isTotal || isWeightOnly)) {
      const t = impParseTotalsBlock(b);
      if (t.items.length) foods.push({ date: dateIso, items: t.items });
      if (t.weight != null) weights.push({ date: dateIso, kg: t.weight });
      continue;
    }
    if (isWorkout && wantWorkouts) {
      const r = impParseWorkoutBlock(b);
      if (!r.workout.exercises.length) continue;
      workouts.push({ date: dateIso, name: String(r.workout.name || "Тренировка").replace(/^[\s—–\-:]+|[\s—–\-:]+$/g, "") || "Тренировка", exercises: r.workout.exercises });
      if (r.weight != null) weights.push({ date: dateIso, kg: r.weight });
    }
  }
  foods.forEach(d => d.items.forEach(it => { if (it.noKbju) warnings.push("нет КБЖУ: «" + it.name + "» (" + d.date + ") — будет 0 ккал"); }));
  return { workouts, weights, foods, warnings };
}

/* ================= UI ================= */
function openTextImport() {
  const years = [];
  const nowY = new Date().getFullYear();
  for (let y = nowY; y >= nowY - 5; y--) years.push(`<option value="${y}"${y === nowY - 1 ? " selected" : ""}>${y}</option>`);
  openModal(`
    <div class="modal-head"><h3>Импорт из текстового дневника</h3><button class="close-x" data-action="closeModal">✕</button></div>
    <p class="hint" style="margin:0 0 10px">Вставь текст — приложение разберёт тренировки с подходами, вес тела и приёмы еды. Можно импортировать только тренировки или только еду.</p>
    <label class="field">Текст<textarea id="impText" rows="12" placeholder="2 ноября грудь трицепс&#10;1. Жим лёжа 70 кг 4 раза+85 кг 4 раза&#10;На данный момент Вес 89,4&#10;17 июня&#10;Утром 200 грамм вареной колбасы (на 100 12.8 б, 22.2 ж)" style="font-size:13px"></textarea></label>
    <div class="field-grid" style="grid-template-columns:1fr 1fr;align-items:end">
      <label class="field">Год первой записи<select id="impYear">${years}</select></label>
      <label class="autocal-chk" style="margin:0 0 4px"><input type="checkbox" id="impAuto" checked> Даты идут по порядку — год подставлять самому (декабрь → январь = новый год)</label>
    </div>
    <div class="btn-row" style="margin-top:8px">
      <label class="autocal-chk"><input type="checkbox" id="impDoW" checked> Тренировки и веса</label>
      <label class="autocal-chk"><input type="checkbox" id="impDoF" checked> Питание</label>
    </div>
    <div class="hint">⚠️ Годы в тексте не указаны: стартует от «Года первой записи», дальше считается по порядку месяцев. Если записи в тексте перемешаны — сними галочку авто-года.</div>
    <div class="btn-row"><button data-action="parseImport">Разобрать</button></div>
    <div id="impResult"></div>
  `);
}

function parseImport() {
  const text = $("#impText").value.trim();
  const out = $("#impResult");
  if (!text) { out.innerHTML = `<div class="empty">Вставь текст дневника.</div>`; return; }
  const r = impParseAll(text, +$("#impYear").value, $("#impAuto").checked, $("#impDoW").checked, $("#impDoF").checked);
  impImportState = r;
  if (!r.workouts.length && !r.weights.length && !r.foods.length) {
    out.innerHTML = `<div class="empty">Ничего не распознано. Проверь год и формат — пример в поле ввода.</div>`;
    return;
  }
  const foodCal = d => Math.round(d.items.reduce((s, it) => s + it.cal, 0));
  const haveData = (d) => data.foods.some(f => f.date === d) || data.weights.some(w => w.date === d) || data.workouts.some(w => w.date === d);
  const existing = [...new Set([...r.workouts, ...r.weights, ...r.foods].map(x => x.date).filter(d => haveData(d)))];
  out.innerHTML = `
    <div class="stat-grid" style="margin-top:12px">
      <div class="card"><span>Тренировок</span><strong>${r.workouts.length}</strong></div>
      <div class="card"><span>Записей веса</span><strong>${r.weights.length}</strong></div>
      <div class="card"><span>Дней питания</span><strong>${r.foods.length}</strong></div>
    </div>
    ${existing.length ? `<div class="hint" style="color:var(--danger);margin-top:8px">⚠️ На датах ${existing.map(fmtDateRu).join(", ")} уже есть записи — повторный импорт даст дубли.</div>` : ""}
    ${r.warnings.length ? `<div class="hint" style="color:var(--danger);margin-top:8px">${r.warnings.slice(0, 8).map(w => esc(w)).join("<br>")}${r.warnings.length > 8 ? `<br>и ещё ${r.warnings.length - 8}…` : ""}</div>` : ""}
    <details class="help" style="margin-top:10px"><summary>Показать детали (${r.workouts.length + r.weights.length + r.foods.length} записей)</summary>
      <div style="margin-top:8px;font-size:13px">
        ${r.workouts.map(w => `<div>🏋️ ${fmtDateRu(w.date)} — ${esc(w.name)} (${w.exercises.length} упр.)</div>`).join("")}
        ${r.weights.map(w => `<div>⚖️ ${fmtDateRu(w.date)} — ${w.kg.toFixed(1)} кг</div>`).join("")}
        ${r.foods.map(d => `<div>🍽 ${fmtDateRu(d.date)} — ${d.items.length} поз., ≈${foodCal(d)} ккал</div>`).join("")}
      </div>
    </details>
    <div class="btn-row"><button data-action="applyImport">Добавить всё в дневник</button></div>`;
}
let impImportState = null;

function applyImport() {
  const r = impImportState;
  if (!r) return;
  r.workouts.forEach(w => {
    data.workouts.push(touch({ id: uid(), date: w.date, name: w.name, minutes: 0, cal: 0, details: "", status: "done", exercises: w.exercises.map(e => ({ name: e.name, sets: e.sets })) }));
  });
  r.weights.forEach(w => data.weights.push(touch({ id: uid(), date: w.date, kg: w.kg, createdAt: Date.now() })));
  r.foods.forEach(d => d.items.forEach(it => {
    data.foods.push(touch({ id: uid(), date: d.date, meal: it.meal, name: it.name, grams: it.grams, cal: it.cal, p: it.p, f: it.f, c: it.c }));
  }));
  // «Итог дня» — служебный приём для сводок Дипсика
  if (r.foods.some(d => d.items.some(it => it.meal === "Итог дня")) && !data.settings.mealNames.includes("Итог дня")) {
    data.settings.mealNames.push("Итог дня");
  }
  const total = r.workouts.length + r.weights.length + r.foods.reduce((s, d) => s + d.items.length, 0);
  closeModal();
  refresh();
  toast(`Импортировано записей: ${total}`);
}

actions.textImport = openTextImport;
actions.parseImport = parseImport;
actions.applyImport = applyImport;
