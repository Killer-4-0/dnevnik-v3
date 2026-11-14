/* Графики на TradingView Lightweight Charts v4 (vendor/lightweight-charts.js).
   API: Charts.weight(el, weights, goal) · Charts.calories(el, days, vals, goal)
        Charts.load(el, pts) · Charts.dispose(el) */
(function () {
  "use strict";
  const LW = window.LightweightCharts;
  const COL = {
    text: "#8ba3c4", grid: "rgba(139,163,196,.09)", cross: "rgba(139,163,196,.4)",
    blue: "#4da3ff", violet: "#8b6cf6", green: "#4ae68d", red: "#ff6b7a", muted: "#22314e"
  };
  const registry = new Map();

  /* ---------- утилиты ---------- */
  const dayNum = iso => Math.floor(Date.parse(iso + "T00:00:00Z") / 86400000);
  const isoOf = n => new Date(n * 86400000).toISOString().slice(0, 10);
  const ruDate = iso => iso.slice(8, 10) + "." + iso.slice(5, 7) + "." + iso.slice(0, 4);
  const f1 = v => (Math.round(v * 10) / 10).toString().replace(".", ",");
  const f0 = v => String(Math.round(v));
  function tkey(t) {
    if (typeof t === "string") return t;
    if (t && t.year) return t.year + "-" + String(t.month).padStart(2, "0") + "-" + String(t.day).padStart(2, "0");
    return "";
  }

  // скользящее среднее по календарному окну (win дней), а не по числу записей
  function movingAvg(pts, win) {
    return pts.map((p, i) => {
      const d = dayNum(p.time);
      let s = 0, n = 0;
      for (let k = i; k >= 0 && dayNum(pts[k].time) > d - win; k--) { s += pts[k].value; n++; }
      return { time: p.time, value: Math.round(s / n * 100) / 100 };
    });
  }

  function dispose(el) {
    const c = registry.get(el);
    if (c) { try { c.remove(); } catch (e) { /* уже удалён */ } registry.delete(el); }
    el.innerHTML = "";
  }

  function make(el, height, opts) {
    dispose(el);
    if (!LW) throw new Error("библиотека графиков не загрузилась");
    const bar = document.createElement("div");
    bar.className = "lwc-bar";
    const box = document.createElement("div");
    box.className = "lwc-box";
    box.style.height = height + "px";
    el.appendChild(bar);
    el.appendChild(box);
    const interactive = !opts || opts.interactive !== false;
    const chart = LW.createChart(box, {
      autoSize: true,
      layout: { background: { type: "solid", color: "transparent" }, textColor: COL.text, fontSize: 12 },
      grid: { vertLines: { visible: false }, horzLines: { color: COL.grid } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.14, bottom: 0.1 } },
      timeScale: { borderVisible: false, timeVisible: false, rightOffset: 1, fixRightEdge: true },
      crosshair: {
        mode: 1,
        vertLine: { color: COL.cross, style: 3, labelVisible: false },
        horzLine: { visible: false, labelVisible: false }
      },
      localization: { locale: "ru-RU", priceFormatter: (opts && opts.fmt) || f1 },
      handleScroll: interactive ? { pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false, mouseWheel: false } : false,
      handleScale: interactive ? { pinch: true, mouseWheel: false, axisPressedMouseMove: false } : false
    });
    registry.set(el, chart);
    return { chart, box, bar };
  }

  function tooltip(box, chart, render) {
    const tip = document.createElement("div");
    tip.className = "lwc-tip";
    tip.style.display = "none";
    box.appendChild(tip);
    chart.subscribeCrosshairMove(p => {
      const key = p && p.time ? tkey(p.time) : "";
      if (!key || !p.point || p.point.x < 0 || p.point.y < 0) { tip.style.display = "none"; return; }
      const html = render(key, p);
      if (!html) { tip.style.display = "none"; return; }
      tip.innerHTML = html;
      tip.style.display = "block";
      const w = tip.offsetWidth;
      let x = p.point.x + 14;
      if (x + w > box.clientWidth - 4) x = p.point.x - w - 14;
      tip.style.left = Math.max(4, x) + "px";
      tip.style.top = "4px";
    });
  }

  function rangeButtons(bar, chart, lastIso, firstIso, defDays, endIso) {
    endIso = endIso || lastIso;
    const opts = [["30 дн", 30], ["90 дн", 90], ["Всё", 0]].filter(o => !o[1] || dayNum(lastIso) - dayNum(firstIso) > o[1] * 0.6);
    const apply = days => {
      try {
        if (!days) chart.timeScale().fitContent();
        else chart.timeScale().setVisibleRange({ from: isoOf(dayNum(lastIso) - days), to: endIso });
      } catch (e) { chart.timeScale().fitContent(); }
      bar.querySelectorAll("button").forEach(b => b.classList.toggle("on", +b.dataset.days === days));
    };
    opts.forEach(([label, days]) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.dataset.days = days;
      b.addEventListener("click", () => apply(days));
      bar.appendChild(b);
    });
    apply(opts.some(o => o[1] === defDays) ? defDays : 0);
  }

  /* ---------- Вес ---------- */
  function weightLW(el, weights, goal, trend) {
    if (!weights || weights.length < 2) { dispose(el); return; }
    const m = make(el, 230);
    if (!m) return;
    const byDay = new Map();
    weights.forEach(w => byDay.set(w.date, w.kg)); // несколько записей за день → последняя
    const raw = [...byDay].map(([time, value]) => ({ time, value })).sort((a, b) => (a.time < b.time ? -1 : 1));
    const avg = movingAvg(raw, 7);

    const dots = m.chart.addLineSeries({
      color: "rgba(77,163,255,.55)", lineVisible: false, pointMarkersVisible: true, pointMarkersRadius: 2.5,
      priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false
    });
    dots.setData(raw);
    const line = m.chart.addAreaSeries({
      lineColor: COL.blue, lineWidth: 3, topColor: "rgba(77,163,255,.22)", bottomColor: "rgba(77,163,255,0)",
      priceLineVisible: false, lastValueVisible: true, crosshairMarkerRadius: 5
    });
    line.setData(avg);
    if (goal) line.createPriceLine({ price: goal, color: COL.green, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "цель" });

    // прогноз: к цели (зелёный) или на 30 дней вперёд по текущему темпу (фиолетовый)
    const last = avg[avg.length - 1];
    let fc = null, fcEnd = null, fcText = "";
    if (trend && trend.slope != null) {
      let endTime, endVal, color, text;
      if (trend.target && goal && dayNum(trend.target) > dayNum(last.time)) {
        endTime = trend.target; endVal = goal; color = COL.green; text = "цель " + goal + " кг ≈ " + ruDate(endTime);
      } else {
        endTime = isoOf(dayNum(last.time) + 30);
        endVal = last.value + trend.slope * 30; color = COL.violet; text = "через 30 дн ≈ " + f1(endVal) + " кг";
      }
      fc = m.chart.addLineSeries({ color, lineWidth: 2, lineStyle: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerRadius: 4 });
      fc.setData([{ time: last.time, value: last.value }, { time: endTime, value: Math.round(endVal * 100) / 100 }]);
      fc.setMarkers([{ time: endTime, position: endVal < last.value ? "belowBar" : "aboveBar", color, shape: "circle" }]);
      fcEnd = endTime; fcText = text;
    }

    // тренд за последние 2 недели по сглаженной линии
    const past = [...avg].reverse().find(p => dayNum(p.time) <= dayNum(last.time) - 14);
    if (past) {
      const perWeek = (last.value - past.value) / ((dayNum(last.time) - dayNum(past.time)) / 7);
      const tr = document.createElement("span");
      tr.className = "lwc-trend";
      const toward = goal ? (perWeek < 0 && last.value > goal) || (perWeek > 0 && last.value < goal) : true;
      tr.style.color = Math.abs(perWeek) < 0.05 || !toward ? COL.text : COL.green;
      tr.textContent = (perWeek > 0 ? "+" : "") + f1(perWeek).replace("-", "−") + " кг/нед";
      m.bar.appendChild(tr);
    }
    rangeButtons(m.bar, m.chart, raw[raw.length - 1].time, raw[0].time, 90, fcEnd);

    tooltip(m.box, m.chart, (key, p) => {
      const a = p.seriesData.get(line), r = p.seriesData.get(dots);
      if (!a) {
        const f = fc && p.seriesData.get(fc);
        return f ? `<b>${ruDate(key)}</b><br>Прогноз: <b>${f1(f.value)} кг</b>` : "";
      }
      return `<b>${ruDate(key)}</b><br>Вес: <b>${f1(r ? r.value : a.value)} кг</b><br><span style="color:${COL.text}">Среднее 7 дн: ${f1(a.value)} кг</span>`;
    });
    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = "Точки — взвешивания, линия — среднее за 7 дней." + (fc ? ` Пунктир — прогноз по темпу последних 4 недель: ${fcText} (приблизительно).` : "");
    el.appendChild(hint);
  }

  /* ---------- Калории ---------- */
  function caloriesLW(el, days, vals, goal) {
    const m = make(el, 190, { interactive: false, fmt: f0 });
    if (!m) return;
    m.bar.style.display = "none";
    m.chart.applyOptions({ timeScale: { tickMarkFormatter: t => { const k = tkey(t); return k ? k.slice(8, 10) + "." + k.slice(5, 7) : ""; } } });
    const s = m.chart.addHistogramSeries({
      priceFormat: { type: "price", precision: 0, minMove: 1 }, priceLineVisible: false, lastValueVisible: false,
      autoscaleInfoProvider: orig => {
        const r = orig();
        if (r) { r.priceRange.minValue = 0; r.priceRange.maxValue = Math.max(r.priceRange.maxValue, (goal || 0) * 1.12, 500); }
        return r;
      }
    });
    s.setData(days.map((d, i) => ({
      time: d, value: vals[i],
      color: !vals[i] ? COL.muted : goal && vals[i] > goal ? COL.red : COL.blue
    })));
    if (goal) s.createPriceLine({ price: goal, color: COL.green, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "цель" });
    m.chart.timeScale().fitContent();

    const logged = vals.filter(v => v > 0);
    if (logged.length) {
      const avg = logged.reduce((a, b) => a + b, 0) / logged.length;
      const note = document.createElement("div");
      note.className = "hint";
      const over = goal ? logged.filter(v => v > goal).length : 0;
      note.textContent = `В среднем ${f0(avg)} ккал/день` + (goal ? ` · выше цели: ${over} из ${logged.length} дн.` : "") + ` · дней без записей: ${vals.length - logged.length}`;
      el.appendChild(note);
    }
    tooltip(m.box, m.chart, (key, p) => {
      const d = p.seriesData.get(s);
      if (!d) return "";
      const diff = goal && d.value ? d.value - goal : null;
      return `<b>${ruDate(key)}</b><br>${d.value ? f0(d.value) + " ккал" : "нет записей"}` +
        (diff != null ? `<br><span style="color:${diff > 0 ? COL.red : COL.green}">${diff > 0 ? "+" : "−"}${f0(Math.abs(diff))} к цели</span>` : "");
    });
  }

  /* ---------- Прогрессия нагрузки (1ПМ) ---------- */
  function loadLW(el, pts) {
    const e1of = p => (p.e1 != null ? p.e1 : (typeof e1rm === "function" ? e1rm(p.kg, p.reps) : 0));
    const byDay = new Map();
    pts.forEach(p => {
      const e1 = e1of(p);
      if (!(e1 > 0)) return; // подходы без повторов (105×0 и т.п.) не рисуем
      const cur = byDay.get(p.date);
      if (!cur || e1 > cur.e1) byDay.set(p.date, { e1, kg: p.kg, reps: p.reps });
    });
    const days = [...byDay.keys()].sort();
    if (days.length < 2) { dispose(el); el.innerHTML = '<div class="empty">Нужно минимум 2 тренировки с подходами, где есть повторы.</div>'; return; }
    const m = make(el, 230);
    if (!m) return;

    const e1Data = days.map(d => ({ time: d, value: byDay.get(d).e1 }));
    const kgData = days.map(d => ({ time: d, value: byDay.get(d).kg }));
    const kgS = m.chart.addLineSeries({
      color: "rgba(77,163,255,.7)", lineWidth: 1, lineStyle: 2, pointMarkersVisible: true, pointMarkersRadius: 2.5,
      priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false
    });
    kgS.setData(kgData);
    const e1S = m.chart.addAreaSeries({
      lineColor: COL.violet, lineWidth: 3, topColor: "rgba(139,108,246,.22)", bottomColor: "rgba(139,108,246,0)",
      priceLineVisible: false, lastValueVisible: true, crosshairMarkerRadius: 5
    });
    e1S.setData(e1Data);

    // зелёные кружки — новые рекорды 1ПМ
    let best = 0;
    const markers = [];
    e1Data.forEach((p, i) => {
      if (p.value > best + 0.05) { if (i > 0) markers.push({ time: p.time, position: "aboveBar", color: COL.green, shape: "circle" }); best = p.value; }
    });
    e1S.setMarkers(markers);

    rangeButtons(m.bar, m.chart, days[days.length - 1], days[0], 0);
    tooltip(m.box, m.chart, (key, p) => {
      const e = p.seriesData.get(e1S), d = byDay.get(key);
      if (!e || !d) return "";
      return `<b>${ruDate(key)}</b><br>1ПМ: <b>${f1(e.value)} кг</b><br><span style="color:${COL.text}">Тяжёлый подход: ${f1(d.kg)} × ${d.reps}</span>`;
    });
  }

  /* ---------- Запасной график (простой SVG), если основная библиотека не сработала ---------- */
  function fallbackChart(el, spec, err) {
    dispose(el);
    const W = Math.max(el.clientWidth || 0, 300), H = spec.height || 210;
    const pl = 8, pr = 44, pt = 12, pb = 24;
    const all = [];
    (spec.lines || []).forEach(l => l.pts.forEach(p => all.push(p)));
    (spec.bars || []).forEach(p => all.push(p));
    if (!all.length) return;
    const t0 = Math.min(...all.map(p => dayNum(p.time))), t1 = Math.max(...all.map(p => dayNum(p.time)), t0 + 1);
    let vals = all.map(p => p.value);
    if (spec.goal) vals.push(spec.goal);
    let lo = spec.bars ? 0 : Math.min(...vals), hi = Math.max(...vals);
    if (hi === lo) { hi += 1; lo -= 1; }
    const padv = (hi - lo) * 0.06; hi += padv; if (!spec.bars) lo -= padv;
    const X = t => pl + (dayNum(t) - t0) / (t1 - t0) * (W - pl - pr);
    const Y = v => pt + (1 - (v - lo) / (hi - lo)) * (H - pt - pb);
    const fmt = spec.fmt || f1;
    let g = "";
    for (let i = 0; i <= 3; i++) {
      const v = lo + (hi - lo) * i / 3, y = Y(v);
      g += `<line x1="${pl}" x2="${W - pr}" y1="${y}" y2="${y}" stroke="${COL.grid}"/><text x="${W - pr + 4}" y="${y + 4}" fill="${COL.text}" font-size="12">${fmt(v)}</text>`;
    }
    [t0, Math.round((t0 + t1) / 2), t1].forEach((d, i) => {
      const iso = isoOf(d);
      g += `<text x="${Math.min(Math.max(pl + (d - t0) / (t1 - t0) * (W - pl - pr), pl + 14), W - pr - 14)}" y="${H - 6}" fill="${COL.text}" font-size="12" text-anchor="middle">${iso.slice(8, 10)}.${iso.slice(5, 7)}</text>`;
    });
    if (spec.bars) {
      const bw = Math.max(3, (W - pl - pr) / Math.max(spec.bars.length, 1) * 0.65);
      spec.bars.forEach(p => { const y = Y(p.value); g += `<rect x="${X(p.time) - bw / 2}" y="${y}" width="${bw}" height="${Math.max(0, Y(0) - y)}" rx="2" fill="${p.color || COL.blue}"/>`; });
    }
    (spec.lines || []).forEach(l => {
      const d = l.pts.map((p, i) => (i ? "L" : "M") + X(p.time).toFixed(1) + " " + Y(p.value).toFixed(1)).join(" ");
      g += `<path d="${d}" fill="none" stroke="${l.color}" stroke-width="${l.width || 2}" ${l.dash ? 'stroke-dasharray="5 4"' : ""} stroke-linejoin="round"/>`;
      if (l.dots) l.pts.forEach(p => { g += `<circle cx="${X(p.time).toFixed(1)}" cy="${Y(p.value).toFixed(1)}" r="2.4" fill="${l.color}" opacity=".55"/>`; });
    });
    if (spec.goal) g += `<line x1="${pl}" x2="${W - pr}" y1="${Y(spec.goal)}" y2="${Y(spec.goal)}" stroke="${COL.green}" stroke-dasharray="4 4"/><text x="${pl + 4}" y="${Y(spec.goal) - 4}" fill="${COL.green}" font-size="12">цель ${fmt(spec.goal)}</text>`;
    const note = (spec.note || "") + (err ? ` <span style="opacity:.6">(упрощённый график: ${String((err && err.message) || err).slice(0, 80)})</span>` : "");
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block" role="img">${g}</svg>${note ? `<div class="hint">${note}</div>` : ""}`;
  }
  function weightPrep(weights) {
    const byDay = new Map();
    weights.forEach(w => byDay.set(w.date, w.kg));
    const raw = [...byDay].map(([time, value]) => ({ time, value })).sort((a, b) => (a.time < b.time ? -1 : 1));
    return { raw, avg: movingAvg(raw, 7) };
  }
  function loadPrep(pts) {
    const e1of = p => (p.e1 != null ? p.e1 : (typeof e1rm === "function" ? e1rm(p.kg, p.reps) : 0));
    const byDay = new Map();
    pts.forEach(p => { const e1 = e1of(p); if (!(e1 > 0)) return; const cur = byDay.get(p.date); if (!cur || e1 > cur.e1) byDay.set(p.date, { e1, kg: p.kg, reps: p.reps }); });
    const days = [...byDay.keys()].sort();
    return { byDay, days };
  }

  function weight(el, weights, goal, trend) {
    if (!weights || weights.length < 2) { dispose(el); return; }
    try { weightLW(el, weights, goal, trend); } catch (e) {
      const { raw, avg } = weightPrep(weights);
      fallbackChart(el, { lines: [{ pts: raw, color: "rgba(77,163,255,.7)", width: 1, dots: true }, { pts: avg, color: COL.blue, width: 3 }], goal, note: "Точки — взвешивания, линия — среднее за 7 дней." }, e);
    }
  }
  function calories(el, days, vals, goal) {
    try { caloriesLW(el, days, vals, goal); } catch (e) {
      fallbackChart(el, { height: 190, fmt: f0, bars: days.map((d, i) => ({ time: d, value: vals[i], color: !vals[i] ? COL.muted : goal && vals[i] > goal ? COL.red : COL.blue })), goal }, e);
    }
  }
  function load(el, pts) {
    const { byDay, days } = loadPrep(pts);
    if (days.length < 2) { dispose(el); el.innerHTML = '<div class="empty">Нужно минимум 2 тренировки с подходами, где есть повторы.</div>'; return; }
    try { loadLW(el, pts); } catch (e) {
      fallbackChart(el, { lines: [{ pts: days.map(d => ({ time: d, value: byDay.get(d).kg })), color: "rgba(77,163,255,.8)", width: 1, dash: true, dots: true }, { pts: days.map(d => ({ time: d, value: byDay.get(d).e1 })), color: COL.violet, width: 3 }] }, e);
    }
  }

  window.Charts = { weight, calories, load, dispose, _movingAvg: movingAvg };
})();
