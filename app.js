/* CQA UI — один самодостаточный компонент (#cqa-root). Зависимостей нет. */
(function () {
  "use strict";
  const API = (window.CQA_API_BASE || "").replace(/\/$/, "");
  const root = document.getElementById("cqa-root");

  /* ───────── утилиты ───────── */
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const $ = (s, el = root) => el.querySelector(s);
  const $$ = (s, el = root) => [...el.querySelectorAll(s)];
  const SP = { client: "Клиент", operator: "Оператор", bot: "Бот", system: "Система" };
  const f2 = n => (n == null ? "—" : Number(n).toFixed(2));
  const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
  let analyticsCharts = [];
  async function api(url, opt = {}) {
    const r = await fetch(API + url, { headers: { "Content-Type": "application/json" }, ...opt });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
  }
  const decLabel = d => d === "YES" ? "Да" : d === "NO" ? "Нет" : String(d);
  const scoreCls = v => v == null ? "" : v >= 85 ? "hi" : v >= 60 ? "mid" : "lo";

  const S = {
    page: "dialogs", health: {}, convs: [], appeals: [], checklist: null, versions: [], draft: null,
    analytics: null, analyticsOperator: "all", analyticsFilters: { channel: "", language: "" },
    exportDataset: lsGet("cqaExportDataset") || "dev", teamName: lsGet("cqaTeamName") || "",
    f: { q: "", channel: "", lang: "", state: "" },
    card: null, evalIdx: 0, batch: null
  };

  /* ───────── каркас ───────── */
  root.innerHTML = `
    <div class="hdr"><div><h1>CQA · Оценка качества диалогов</h1><small>Freedom Broker</small></div><div class="row" id="hdrInfo"></div></div>
    <div class="tabs"><button data-page="dialogs" class="on">Диалоги</button><button data-page="analytics">Аналитика</button><button data-page="appeals">Апелляции <span id="apCnt"></span></button><button data-page="settings">Чек-лист</button></div>
    <div class="main">
      <div id="notice"></div>
      <section id="p-dialogs"></section>
      <section id="p-card" class="hide"></section>
      <section id="p-analytics" class="hide"></section>
      <section id="p-appeals" class="hide"></section>
      <section id="p-settings" class="hide"></section>
    </div>
    <dialog id="dlg"></dialog>`;

  function notice(msg, kind = "ok", ms = 6000) {
    $("#notice").innerHTML = msg ? `<div class="msgbox ${kind}">${esc(msg)}</div>` : "";
    if (msg && ms) setTimeout(() => { if ($("#notice .msgbox")?.textContent === msg) $("#notice").innerHTML = ""; }, ms);
  }
  function showPage(p) {
    S.page = p;
    if (p !== "analytics") destroyAnalyticsCharts();
    for (const id of ["dialogs", "card", "analytics", "appeals", "settings"]) $("#p-" + id).classList.toggle("hide", id !== (p === "dialogs" && S.card ? "card" : p));
    $$(".tabs button").forEach(b => b.classList.toggle("on", b.dataset.page === p));
    if (p === "analytics") loadAnalytics();
    if (p === "appeals") loadAppeals(); if (p === "settings") loadSettings();
    window.scrollTo(0, 0);
  }
  $$(".tabs button").forEach(b => b.onclick = () => { if (b.dataset.page === "dialogs") S.card = null; showPage(b.dataset.page); if (b.dataset.page === "dialogs") loadConvs(); });

  /* ───────── список диалогов ───────── */
  async function loadHealth() {
    S.health = await api("/api/health");
    $("#hdrInfo").innerHTML = S.health.aiConfigured
      ? `<span class="pill ok">AI: ${esc(S.health.model)}</span>`
      : `<span class="pill err">${S.health.transcriptionConfigured ? "Ключ AI не настроен или имеет неверный формат" : "Задайте секретный OPENAI_API_KEY (обычно начинается с sk-) в .env"}</span>`;
  }
  async function loadConvs() {
    S.convs = await api("/api/conversations");
    renderDialogs();
  }
  async function loadAnalytics() {
    $("#p-analytics").innerHTML = `<div class="card muted">Загружаем аналитику…</div>`;
    try {
      const params = new URLSearchParams();
      if (S.analyticsFilters.channel) params.set("channel", S.analyticsFilters.channel);
      if (S.analyticsFilters.language) params.set("language", S.analyticsFilters.language);
      S.analytics = await api(`/api/analytics?${params.toString()}`);
      renderAnalytics();
    } catch (error) {
      $("#p-analytics").innerHTML = `<div class="msgbox err">Не удалось загрузить аналитику: ${esc(error.message)}</div><button id="retryAnalytics">Повторить</button>`;
      $("#retryAnalytics").onclick = loadAnalytics;
    }
  }
  function destroyAnalyticsCharts() {
    analyticsCharts.forEach(chart => chart.destroy());
    analyticsCharts = [];
  }
  function channelLabel(value) {
    const channel = value.toLowerCase();
    if (channel.includes("chat")) return "Чат";
    if (channel.includes("call") || channel.includes("phone")) return "Звонок";
    return value;
  }
  function languageLabel(value) {
    return ({ RU: "Русский", KZ: "Казахский", EN: "Английский" })[value] || value;
  }
  function renderAnalytics() {
    const data = S.analytics;
    const operator = data.operators.find(item => item.id === S.analyticsOperator);
    if (S.analyticsOperator !== "all" && !operator) S.analyticsOperator = "all";
    const summary = S.analyticsOperator === "all" ? data.overall : operator || data.overall;
    const criteria = summary.criteria
      .filter(criterion => criterion.average_score != null)
      .sort((a, b) => a.average_score - b.average_score || a.name.localeCompare(b.name, "ru"));
    const weakest = criteria[0] || null;
    $("#p-analytics").innerHTML = `
      <div class="toolbar analytics-toolbar"><div><h2>Аналитика</h2><div class="muted small">По последней оценке каждого диалога</div></div>
        <div class="row analytics-filters">
          <label>Канал<select id="analyticsChannel"><option value="">Все каналы</option>
            ${data.filter_options.channels.map(value => `<option value="${esc(value)}" ${value === S.analyticsFilters.channel ? "selected" : ""}>${esc(channelLabel(value))}</option>`).join("")}</select></label>
          <label>Язык<select id="analyticsLanguage"><option value="">Все языки</option>
            ${data.filter_options.languages.map(value => `<option value="${esc(value)}" ${value === S.analyticsFilters.language ? "selected" : ""}>${esc(languageLabel(value))}</option>`).join("")}</select></label>
          ${data.operator_data_available ? `<label>Оператор<select id="analyticsOperator"><option value="all">Все операторы</option>
            ${data.operators.map(item => `<option value="${esc(item.id)}" ${item.id === S.analyticsOperator ? "selected" : ""}>${esc(item.name)}</option>`).join("")}</select></label>` : ""}
          <button id="refreshAnalytics" class="sec">Обновить</button></div></div>
      ${!data.evaluated_conversations ? `<div class="card muted">Пока нет оценок. Запустите оценку диалогов — аналитика появится здесь.</div>` : ""}
      ${!data.operator_data_available ? `<div class="msgbox analytics-note">${esc(data.operator_identifier_note)}</div>`
        : data.unassigned_operator_conversations ? `<div class="msgbox analytics-note">${data.unassigned_operator_conversations} оценок не привязаны к оператору и учитываются только в общей сводке.</div>` : ""}
      <div class="stats analytics-stats">
        <div class="stat"><b>${summary.evaluations}</b><span>оценённых диалогов</span></div>
        <div class="stat"><b>${summary.average_score == null ? "—" : f2(summary.average_score)}</b><span>средний балл из 100</span></div>
        <div class="stat"><b>${summary.gross_error_count}</b><span>грубых ошибок · в ${summary.gross_error_dialogs} диалогах</span></div>
        <div class="stat"><b>${data.appeal_count}</b><span>апелляций · ${data.pending_appeal_count} ожидают решения</span></div>
      </div>
      <div class="analytics-chart-grid">
        <div class="card analytics-chart-card criteria-chart-card"><div class="analytics-heading"><h3>Средний балл по критериям</h3>
          <span class="analytics-weakest">${weakest ? `Самый слабый: ${esc(weakest.name)} · ${f2(weakest.average_score)}%` : "Нет данных для построения"}</span></div>
          <div class="analytics-chart criteria-chart" style="height:${Math.max(260, criteria.length * 34)}px"><canvas id="criteriaChart" aria-label="Столбчатая диаграмма среднего балла по критериям"></canvas></div>
          <div class="muted small analytics-footnote">Критерии с самым низким средним баллом расположены первыми. N/A и грубые нарушения не включены.</div></div>
        <div class="card analytics-chart-card"><div class="analytics-heading"><h3>Распределение итоговых баллов</h3></div>
          <div class="analytics-chart"><canvas id="scoreHistogram" aria-label="Гистограмма итоговых оценок"></canvas></div></div>
        <div class="card analytics-chart-card"><div class="analytics-heading"><h3>Профиль по секциям</h3></div>
          <div class="analytics-chart"><canvas id="sectionRadar" aria-label="Радарная диаграмма профиля по секциям чек-листа"></canvas></div></div>
      </div>
      <div class="muted small analytics-footnote">Апелляции считаются по выбранным каналу и языку независимо от фильтра оператора; число ожидающих требует решения.</div>
      ${data.operator_data_available ? `<div class="card"><div class="analytics-heading"><h3>Сводка по операторам</h3><span class="muted small">Нажмите на оператора, чтобы отфильтровать аналитику</span></div>
        <div class="analytics-table-wrap"><table class="analytics-table"><thead><tr><th>Оператор</th><th>Диалогов</th><th>Средний балл</th><th>Диалогов с грубыми ошибками</th></tr></thead><tbody>
          ${data.operators.map(item => `<tr class="operator-row ${item.id === S.analyticsOperator ? "selected" : ""}" data-operator="${esc(item.id)}">
            <td><b>${esc(item.name)}</b></td><td>${item.evaluations}</td><td>${item.average_score == null ? "—" : f2(item.average_score)}</td>
            <td>${item.gross_error_dialogs}</td></tr>`).join("")}
        </tbody></table></div></div>` : ""}
    `;
    $("#analyticsChannel").onchange = event => { S.analyticsFilters.channel = event.target.value; loadAnalytics(); };
    $("#analyticsLanguage").onchange = event => { S.analyticsFilters.language = event.target.value; loadAnalytics(); };
    if ($("#analyticsOperator")) $("#analyticsOperator").onchange = event => { S.analyticsOperator = event.target.value; renderAnalytics(); };
    $("#refreshAnalytics").onclick = loadAnalytics;
    $$("[data-operator]", $("#p-analytics")).forEach(row => row.onclick = () => {
      S.analyticsOperator = row.dataset.operator;
      renderAnalytics();
      window.scrollTo(0, 0);
    });
    renderAnalyticsCharts(summary, criteria);
  }
  function renderAnalyticsCharts(summary, criteria) {
    destroyAnalyticsCharts();
    if (typeof window.Chart !== "function") {
      throw new Error("Не удалось загрузить Chart.js из папки Chart.js-master.");
    }
    const sharedFont = { family: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" };
    analyticsCharts.push(new window.Chart($("#criteriaChart"), {
      type: "bar",
      data: {
        labels: criteria.map(criterion => criterion.name),
        datasets: [{
          label: "Средний балл",
          data: criteria.map(criterion => criterion.average_score),
          backgroundColor: criteria.map((_, index) => index === 0 ? "#bd654f" : "#43866a"),
          borderRadius: 5,
          barThickness: 18
        }]
      },
      options: {
        indexAxis: "y",
        maintainAspectRatio: false,
        responsive: true,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: item => ` ${f2(item.parsed.x)}%` } } },
        scales: {
          x: { min: 0, max: 100, ticks: { callback: value => `${value}%`, font: sharedFont }, grid: { color: "#edf1ed" } },
          y: { ticks: { autoSkip: false, font: sharedFont }, grid: { display: false } }
        }
      }
    }));
    analyticsCharts.push(new window.Chart($("#scoreHistogram"), {
      type: "bar",
      data: {
        labels: summary.score_distribution.map(bin => bin.label),
        datasets: [{ label: "Диалоги", data: summary.score_distribution.map(bin => bin.count), backgroundColor: "#43866a", borderRadius: 5, maxBarThickness: 34 }]
      },
      options: {
        maintainAspectRatio: false,
        responsive: true,
        plugins: { legend: { display: false } },
        scales: {
          x: { title: { display: true, text: "Итоговый балл" }, grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 6, font: { size: 10 } } },
          y: { beginAtZero: true, ticks: { precision: 0, stepSize: 1 }, title: { display: true, text: "Количество диалогов" }, grid: { color: "#edf1ed" } }
        }
      }
    }));
    analyticsCharts.push(new window.Chart($("#sectionRadar"), {
      type: "radar",
      data: {
        labels: summary.sections.map(section => section.name),
        datasets: [{
          label: "Средний балл секции",
          data: summary.sections.map(section => section.average_score),
          backgroundColor: "rgba(57, 125, 96, .18)",
          borderColor: "#397d60",
          pointBackgroundColor: "#17634a",
          pointBorderColor: "#fff",
          pointHoverBackgroundColor: "#fff",
          pointHoverBorderColor: "#17634a",
          borderWidth: 2
        }]
      },
      options: {
        maintainAspectRatio: false,
        responsive: true,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: item => ` ${f2(item.parsed.r)}%` } } },
        scales: {
          r: {
            min: 0,
            max: 100,
            ticks: { stepSize: 20, backdropColor: "transparent", callback: value => `${value}%` },
            pointLabels: { font: { size: 11 } },
            grid: { color: "#e5ebe6" },
            angleLines: { color: "#e5ebe6" }
          }
        }
      }
    }));
  }
  function filtered() {
    const f = S.f;
    return S.convs.filter(c =>
      (!f.q || c.conversation_id.toLowerCase().includes(f.q.toLowerCase())) && (!f.channel || c.channel === f.channel) &&
      (!f.lang || c.language === f.lang) &&
      (!f.state || (f.state === "done" ? c.latest_evaluation_id : f.state === "todo" ? !c.latest_evaluation_id : f.state === "gross" ? c.gross_flag : c.pending_appeals > 0)));
  }
  function renderDialogs() {
    const all = S.convs, scored = all.filter(c => c.total_score != null);
    const avg = scored.length ? scored.reduce((s, c) => s + c.total_score, 0) / scored.length : null;
    const rows = filtered();
    const b = S.batch;
    $("#p-dialogs").innerHTML = `
      <div class="toolbar"><h2>Диалоги</h2>
        <div class="row"><button id="bImport" class="sec">⬇ Загрузить DEV</button><button id="bImportProd" class="sec">⬇ Загрузить PROD</button>
          <button id="bEvalTodo">▶ Оценить неоценённые</button><button id="bEvalAll" class="sec">↻ Переоценить все</button>
          <button id="bClearResults" class="danger" ${all.some(c => c.latest_evaluation_id) || all.some(c => c.pending_appeals) ? "" : "disabled"}>Сбросить результаты</button></div></div>
      <div class="card export-card">
        <div><h3>Экспорт результатов для Git</h3><div class="muted small">Перед скачиванием проверяются число записей, ID и формат всех 8 критериев.</div></div>
        <div class="row export-controls">
          <label>Набор<select id="exportDataset"><option value="dev" ${S.exportDataset === "dev" ? "selected" : ""}>DEV · 65 записей</option><option value="prod" ${S.exportDataset === "prod" ? "selected" : ""}>PROD · 10 записей</option></select></label>
          <label class="team-name-field">Название команды<input id="exportTeamName" maxlength="120" value="${esc(S.teamName)}" placeholder="Например, CQA Team"></label>
          <button id="bExportResults">Экспорт results.json</button>
        </div>
        <div id="exportStatus" aria-live="polite"></div>
      </div>
      ${b ? `<div class="card"><b>${b.cancel ? "Останавливаем…" : "Идёт оценка"}: ${b.done} / ${b.total}</b> ${b.fail ? `<span class="badge bad">ошибок: ${b.fail}</span>` : ""}
        <div class="progress"><i style="width:${b.total ? b.done / b.total * 100 : 0}%"></i></div>
        <div class="small muted">${esc(b.last || "")}</div><button id="bCancel" class="sec sm">Остановить</button></div>` : ""}
      <div class="stats">
        <div class="stat"><b>${all.length}</b><span>диалогов</span></div>
        <div class="stat"><b>${all.filter(c => c.channel === "voice call").length}</b><span>звонков (с аудио)</span></div>
        <div class="stat"><b>${all.filter(c => c.latest_evaluation_id).length}</b><span>оценено</span></div>
        <div class="stat"><b>${avg == null ? "—" : avg.toFixed(1)}</b><span>средний балл</span></div>
        <div class="stat"><b>${all.filter(c => c.gross_flag).length}</b><span>с грубой ошибкой</span></div>
        <div class="stat"><b>${all.reduce((s, c) => s + c.pending_appeals, 0)}</b><span>апелляций ждут</span></div></div>
      <div class="row filters" style="margin-bottom:10px">
        <input id="fq" placeholder="Поиск по ID…" value="${esc(S.f.q)}">
        <select id="fch"><option value="">Все каналы</option><option value="agent chat">Чаты</option><option value="voice call">Звонки</option></select>
        <select id="fl"><option value="">Все языки</option><option>RU</option><option>KZ</option><option>EN</option></select>
        <select id="fs"><option value="">Все статусы</option><option value="todo">Не оценены</option><option value="done">Оценены</option><option value="gross">Грубая ошибка</option><option value="appeal">Есть апелляция</option></select>
        <span class="muted small">показано ${rows.length}</span></div>
      <div class="tw"><table><thead><tr><th>ID</th><th>Канал</th><th>Язык</th><th>Реплик</th><th>Запись</th><th>Оценка</th><th></th></tr></thead><tbody>
      ${rows.map(c => `<tr data-open="${esc(c.conversation_id)}" style="cursor:pointer">
        <td><b>${esc(c.conversation_id)}</b></td><td>${c.channel === "voice call" ? "📞 звонок" : "💬 чат"}</td><td>${esc(c.language)}</td><td>${c.message_count}</td>
        <td>${c.has_audio ? "🎧 есть" : "—"}</td>
        <td>${c.total_score == null ? (c.latest_evaluation_id ? "не рассчитана" : '<span class="muted">—</span>') : `<span class="score ${scoreCls(c.total_score)}">${f2(c.total_score)}</span>`}
          ${c.gross_flag ? '<span class="badge bad">грубая ошибка</span>' : ""}${c.pending_appeals ? '<span class="badge warn">апелляция</span>' : ""}</td>
        <td><button class="sec sm">Открыть</button></td></tr>`).join("") || `<tr><td colspan="7" class="muted">Нет диалогов. Нажмите «Загрузить данные из API».</td></tr>`}
      </tbody></table></div>`;
    $("#fch").value = S.f.channel; $("#fl").value = S.f.lang; $("#fs").value = S.f.state;
    const rerenderKeep = () => { const pos = $("#fq").selectionStart; renderDialogs(); const q = $("#fq"); q.focus(); q.setSelectionRange(pos, pos); };
    $("#fq").oninput = e => { S.f.q = e.target.value; rerenderKeep(); };
    $("#fch").onchange = e => { S.f.channel = e.target.value; renderDialogs(); };
    $("#fl").onchange = e => { S.f.lang = e.target.value; renderDialogs(); };
    $("#fs").onchange = e => { S.f.state = e.target.value; renderDialogs(); };
    $("#bImport").onclick = doImport;
    $("#bImportProd").onclick = () => doImport("prod");
    $("#exportDataset").onchange = event => {
      S.exportDataset = event.target.value;
      lsSet("cqaExportDataset", S.exportDataset);
    };
    $("#exportTeamName").oninput = event => {
      S.teamName = event.target.value;
      lsSet("cqaTeamName", S.teamName);
    };
    $("#bExportResults").onclick = exportResults;
    $("#bEvalTodo").onclick = () => runBatch(false); $("#bEvalAll").onclick = () => runBatch(true);
    $("#bClearResults").onclick = clearResults;
    if ($("#bCancel")) $("#bCancel").onclick = () => { S.batch.cancel = true; renderDialogs(); };
    $$("tr[data-open]").forEach(tr => tr.onclick = () => openCard(tr.dataset.open));
    $("#apCnt").textContent = S.convs.reduce((s, c) => s + c.pending_appeals, 0) ? "•" : "";
  }
  async function clearResults() {
    if (S.batch) return notice("Дождитесь завершения пакетной оценки.", "err");
    const evaluated = S.convs.filter(conversation => conversation.latest_evaluation_id).length;
    const pending = S.convs.reduce((sum, conversation) => sum + conversation.pending_appeals, 0);
    if (!evaluated && !pending) return notice("Нет результатов для сброса.");
    if (!confirm(`Удалить все оценки и все связанные с ними апелляции, включая закрытые?\\n\\nСейчас оценки есть у ${evaluated} диалогов; ожидают решения ${pending} апелляций. Диалоги, аудио и чек-листы сохранятся. Действие необратимо.`)) return;
    const button = $("#bClearResults");
    button.disabled = true;
    try {
      const result = await api("/api/evaluations", { method: "DELETE" });
      S.appeals = [];
      await loadConvs();
      $("#apCnt").textContent = "";
      notice(`Сброшено оценок: ${result.evaluations}; удалено апелляций: ${result.appeals}. Диалоги и чек-листы сохранены.`);
    } catch (error) {
      button.disabled = false;
      notice(`Не удалось сбросить результаты: ${error.message}`, "err", 0);
    }
  }
  async function doImport(dataset = "dev") {
    let groupId = "";
    if (dataset === "prod") {
      groupId = String(prompt("Введите group_id контрольного набора PROD, полученный от организаторов:") || "").trim();
      if (!groupId) return;
    }
    const btn = dataset === "prod" ? $("#bImportProd") : $("#bImport");
    btn.disabled = true; notice(`Загружаем набор ${dataset.toUpperCase()}…`, "ok", 0);
    try {
      const body = { dataset };
      if (groupId) body.group_id = groupId;
      const result = await api("/api/import", { method: "POST", body: JSON.stringify(body) });
      notice(`Загружено записей: ${result.imported}. Набор: ${result.dataset.toUpperCase()} (${result.dataset_group_id})`);
      await loadConvs();
    } catch (error) {
      notice(error.message, "err", 0);
    } finally {
      btn.disabled = false;
    }
  }
  async function exportResults() {
    const teamName = $("#exportTeamName").value.trim();
    const dataset = $("#exportDataset").value;
    if (!teamName) {
      $("#exportTeamName").focus();
      return notice("Укажите название команды перед экспортом.", "err");
    }
    const button = $("#bExportResults");
    const status = $("#exportStatus");
    button.disabled = true;
    status.innerHTML = `<div class="msgbox">Проверяем набор ${dataset.toUpperCase()} и формируем results.json…</div>`;
    try {
      const query = new URLSearchParams({ dataset, team_name: teamName });
      const response = await fetch(`${API}/api/export/results?${query}`);
      const contentType = response.headers.get("content-type") || "";
      if (!response.ok) {
        const error = contentType.includes("application/json") ? await response.json() : { error: `HTTP ${response.status}` };
        const details = Array.isArray(error.errors) ? `<ul>${error.errors.map(item => `<li>${esc(item)}</li>`).join("")}</ul>` : "";
        status.innerHTML = `<div class="msgbox err"><b>${esc(error.error || "Экспорт не выполнен")}</b>${error.actual_count != null
          ? `<div>Записей: ${error.actual_count} из ${error.expected_count}; корректных оценок: ${error.ok_count}; записей с ошибками оценки: ${error.error_count}.</div>` : ""}${details}</div>`;
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "results.json";
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      const resultCount = Number(response.headers.get("X-Export-Count"));
      const errorCount = Number(response.headers.get("X-Export-Errors"));
      status.innerHTML = `<div class="msgbox ok">Файл results.json скачан: ${Number.isFinite(resultCount) && resultCount ? resultCount : "все"} записей${errorCount ? `, из них с ошибкой оценки: ${errorCount}` : ""}. Перед отправкой разместите его в results/${dataset}/results.json.</div>`;
    } catch (error) {
      status.innerHTML = `<div class="msgbox err">Не удалось скачать results.json: ${esc(error.message)}</div>`;
    } finally {
      button.disabled = false;
    }
  }
  async function runBatch(all) {
    if (S.batch) return;
    if (!S.health.aiConfigured) return notice("Задайте OPENAI_API_KEY или OPENROUTER_API_KEY в .env и перезапустите сервер.", "err", 0);
    const ids = S.convs.filter(c => all || !c.latest_evaluation_id).map(c => c.conversation_id);
    if (!ids.length) return notice("Нечего оценивать.");
    if (all && !confirm(`Переоценить ${ids.length} диалогов активным чек-листом? Это новые запросы к модели.`)) return;
    S.batch = { total: ids.length, done: 0, fail: 0, cancel: false, last: "" }; renderDialogs();
    let k = 0;
    const worker = async () => {
      while (k < ids.length && !S.batch.cancel) {
        const id = ids[k++];
        try { await api(`/api/evaluate/${encodeURIComponent(id)}`, { method: "POST", body: "{}" }); S.batch.last = `${id}: готово`; }
        catch (e) { S.batch.fail++; S.batch.last = `${id}: ${e.message}`; if (/ключ|401|402|баланс/i.test(e.message)) S.batch.cancel = true; }
        S.batch.done++; renderDialogs();
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    const b = S.batch; S.batch = null; await loadConvs();
    notice(`Оценка завершена: ${b.done - b.fail} из ${b.total}${b.fail ? `, ошибок: ${b.fail}. Последняя: ${b.last}` : ""}`, b.fail ? "err" : "ok", 0);
  }

  /* ───────── карточка диалога ───────── */
  async function openCard(id, opts = {}) {
    const conv = await api("/api/conversations/" + encodeURIComponent(id));
    S.card = conv; S.evalIdx = opts.evalId ? Math.max(0, conv.evaluations.findIndex(e => e.id === opts.evalId)) : 0;
    if (S.appeals.length === 0) S.appeals = await api("/api/appeals");
    S.versions = await api("/api/checklists");
    renderCard(); showPage("dialogs");
    if (opts.jump != null) setTimeout(() => jumpTo(opts.jump, { play: false }), 150);
  }
  const shiftKey = c => "cqa_shift_" + c.conversation_id;
  const shiftOf = c => Number(lsGet(shiftKey(c)) || 0) || 0;
  function relSec(c, m) {
    if (c.audio_start_ms == null) return null;
    const t = Date.parse(m.timestamp); return Number.isFinite(t) ? Math.max(0, (t - c.audio_start_ms) / 1000) : null;
  }
  const mmss = s => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  function tsLabel(c, m) { const r = relSec(c, m); return r == null ? m.timestamp : mmss(r); }

  function renderCard() {
    const c = S.card, ev = c.evaluations[S.evalIdx], voice = c.channel === "voice call";
    const act = S.versions.find(v => v.active);
    $("#p-card").innerHTML = `
      <div class="toolbar"><div class="row"><button class="sec" id="back">← К списку</button><h2>${esc(c.conversation_id)}</h2>
        <span class="badge">${voice ? "📞 звонок" : "💬 чат"}</span><span class="badge">${esc(c.language)}</span></div>
        <div class="row"><label style="min-width:210px">Чек-лист<select id="verSel">${S.versions.map(v => `<option value="${v.version}" ${v.active ? "selected" : ""}>v${v.version}${v.active ? " (активный)" : ""} · ${v.criteria} крит.</option>`).join("")}</select></label>
          <button id="runEval" style="margin-top:18px">▶ ${ev ? "Переоценить" : "Оценить"}</button></div></div>
      <div id="cardMsg"></div>
      <div class="grid"><div class="left">
        ${playerHtml(c)}
        <div class="tr" id="tr">${c.transcript.map((m, i) => `<div class="msg ${esc(m.speaker)} ${c.has_audio && relSec(c, m) != null ? "voice" : ""}" data-i="${i}" title="${esc(m.timestamp)}">
          <div class="ts">${esc(tsLabel(c, m))}</div><div><span class="sp">${esc(SP[m.speaker] || (m.speaker === "unknown" ? "Участник" : m.speaker))}</span><span class="idx">#${i}</span><div>${esc(m.text)}</div></div></div>`).join("")}</div></div>
        <div id="resultBox">${ev ? resultHtml(ev) : `<div class="card muted">Оценка ещё не запускалась. Выберите чек-лист и нажмите «Оценить».</div>`}</div></div>`;
    $("#back").onclick = () => { S.card = null; showPage("dialogs"); loadConvs(); };
    $("#runEval").onclick = runEval;
    if (c.has_audio) initPlayer();
    $("#audioUpload").onchange = e => {
      const file = e.target.files[0];
      if (file) uploadAudio(file);
    };
    if ($("#transcribeAudio")) $("#transcribeAudio").onclick = transcribeCurrentAudio;
    $("#runEval").disabled = c.transcription_required;
    if (c.transcription_required) {
      $("#cardMsg").innerHTML = `<div class="msgbox err">Чтобы оценка учитывала загруженную запись, сначала распознайте аудио и создайте транскрипт.</div>`;
    } else if (c.has_audio && !S.health.transcriptionConfigured) {
      $("#cardMsg").innerHTML = `<div class="msgbox">Для распознавания добавьте OPENAI_API_KEY в .env и перезапустите сервер.</div>`;
    } else if (ev && c.audio_transcribed_at && Date.parse(c.audio_transcribed_at) > Date.parse(ev.created_at)) {
      $("#cardMsg").innerHTML = `<div class="msgbox">Транскрипт обновлён после этой оценки. Запустите переоценку, чтобы результат соответствовал новой записи.</div>`;
    }
    $$("#tr .msg.voice").forEach(el => el.onclick = () => seekToMsg(Number(el.dataset.i), true));
    bindResult();
  }
  async function runEval() {
    const btn = $("#runEval"); btn.disabled = true; btn.textContent = "Оцениваем…";
    $("#cardMsg").innerHTML = "";
    try {
      await api(`/api/evaluate/${encodeURIComponent(S.card.conversation_id)}`, { method: "POST", body: JSON.stringify({ checklist_version: Number($("#verSel").value) }) });
      const jumpId = S.card.conversation_id; S.card = null; await openCard(jumpId); notice("Оценка сохранена.");
    } catch (e) { $("#cardMsg").innerHTML = `<div class="msgbox err">${esc(e.message)}</div>`; btn.disabled = false; btn.textContent = "▶ Оценить"; }
  }

  async function uploadAudio(file) {
    const id = S.card.conversation_id;
    $("#cardMsg").innerHTML = `<div class="msgbox">Загружаем аудио…</div>`;
    try {
      const response = await fetch(`${API}/api/conversations/${encodeURIComponent(id)}/audio`, {
        method: "POST",
        headers: { "x-filename": encodeURIComponent(file.name), "Content-Type": "application/octet-stream" },
        body: file
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      S.card.has_audio = true;
      S.card.transcription_required = true;
      renderCard();
      await transcribeCurrentAudio();
    } catch (error) {
      $("#cardMsg").innerHTML = `<div class="msgbox err">${esc(error.message)}</div>`;
    }
  }

  async function transcribeCurrentAudio() {
    const button = $("#transcribeAudio");
    const id = S.card.conversation_id;
    button.disabled = true;
    button.textContent = "Распознаём аудио…";
    $("#cardMsg").innerHTML = `<div class="msgbox">Сначала распознаём речь и создаём транскрипт. После этого можно запустить оценку.</div>`;
    try {
      await api(`/api/conversations/${encodeURIComponent(id)}/transcribe`, { method: "POST", body: "{}" });
      await openCard(id);
      notice("Аудио распознано, транскрипт готов. Теперь можно оценить диалог.");
    } catch (error) {
      $("#cardMsg").innerHTML = `<div class="msgbox err">${esc(error.message)}</div>`;
      button.disabled = false;
      button.textContent = "Распознать и обновить транскрипт";
    }
  }

  /* ───── плеер ───── */
  function playerHtml(c) {
    return `<div class="player"><div class="small" style="margin-bottom:6px">🎧 ${c.has_audio ? "Запись звонка · клик по реплике перематывает на неё" : "Добавьте аудиозапись к диалогу"}</div>
      ${c.has_audio ? `<audio id="aud" controls preload="metadata" src="${API}/api/conversations/${encodeURIComponent(c.conversation_id)}/audio"></audio>` : ""}
      <div id="audErr"></div>
      <label class="small" style="color:#d8e7dc;margin-top:10px">Аудиофайл
        <input id="audioUpload" type="file" accept="audio/*,.mp3,.wav,.ogg,.m4a,.webm,.flac,.aac" aria-label="Выбрать аудиофайл">
      </label>
      ${c.has_audio ? `<div class="row small">
        <button id="transcribeAudio" class="sm">Распознать и обновить транскрипт</button>
        <button class="sm" data-seek="-10">⏪ 10с</button><button class="sm" data-seek="10">10с ⏩</button>
        <label style="color:#c9d4ea">Скорость <select id="spd"><option>0.75</option><option selected>1</option><option>1.25</option><option>1.5</option><option>2</option></select></label>
        <label style="color:#c9d4ea" title="Если реплики попадают не в то место записи, подправьте сдвиг (сек).">Сдвиг, с <input id="shift" type="number" step="0.5" value="${shiftOf(c)}" style="width:70px"></label></div>
        ${c.transcription_required ? '<div class="small" style="margin-top:6px;color:#ffd9a8">Новая запись ожидает распознавания перед оценкой.</div>' : ""}` : ""}
      </div>`;
  }
  function initPlayer() {
    const a = $("#aud"), c = S.card;
    a.addEventListener("error", async () => {
      let why = "Не удалось загрузить запись.";
      try { const r = await fetch(`${API}/api/conversations/${encodeURIComponent(c.conversation_id)}/audio`, { headers: { Range: "bytes=0-0" } }); if (!r.ok) why = (await r.json()).error || why; } catch {}
      $("#audErr").innerHTML = `<div class="msgbox err small" style="color:#ffb4ab;background:#3a1d22">${esc(why)}<br>Можно загрузить аудиофайл выше.</div>`;
    });
    $$("[data-seek]").forEach(b => b.onclick = () => { a.currentTime = Math.max(0, a.currentTime + Number(b.dataset.seek)); });
    $("#spd").onchange = e => { a.playbackRate = Number(e.target.value); };
    $("#shift").onchange = e => { lsSet(shiftKey(c), e.target.value); };
    a.addEventListener("timeupdate", () => {            // подсветка текущей реплики
      const t = a.currentTime - shiftOf(c); let cur = -1;
      c.transcript.forEach((m, i) => { const r = relSec(c, m); if (r != null && r <= t + 0.2) cur = i; });
      $$("#tr .msg.playing").forEach(x => x.classList.remove("playing"));
      if (cur >= 0) { const el = $(`#tr .msg[data-i="${cur}"]`); el.classList.add("playing"); if (!a.paused) keepVisible(el); }
    });
  }
  function keepVisible(el) {
    const box = $("#tr"), top = el.offsetTop - box.offsetTop;
    if (top < box.scrollTop + 20 || top > box.scrollTop + box.clientHeight - 60) box.scrollTo({ top: top - 60, behavior: "smooth" });
  }
  function seekToMsg(i, play) {
    const c = S.card, a = $("#aud"); if (!a) return;
    const r = relSec(c, c.transcript[i]); if (r == null) return;
    const go = () => { a.currentTime = Math.max(0, r + shiftOf(c)); if (play) a.play().catch(() => {}); };
    a.readyState >= 1 ? go() : (a.addEventListener("loadedmetadata", go, { once: true }), a.load());
  }
  // Переход из обоснования к реплике (+ в звонке — к нужному месту записи)
  function jumpTo(i, { play = true } = {}) {
    const el = $(`#tr .msg[data-i="${i}"]`); if (!el) return;
    const box = $("#tr"); box.scrollTo({ top: el.offsetTop - box.offsetTop - 60, behavior: "smooth" });
    el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash");
    if (window.innerWidth < 980) box.scrollIntoView({ behavior: "smooth", block: "center" });
    if (S.card.has_audio) seekToMsg(i, play);
  }

  /* ───── результат ───── */
  function resultHtml(ev) {
    const r = ev.result, c = S.card;
    if (r.schema !== 2) return `<div class="card"><div class="msgbox err">Оценка в старом формате. Нажмите «Переоценить».</div></div>`;
    const openAppeals = S.appeals.filter(a => a.evaluation_id === ev.id);
    const changed = r.original_total_score != null && r.total_score !== r.original_total_score;
    const humanReviews = r.criteria.filter(criterion => criterion.human_review_required !== false).length;
    return `
      <div class="card"><div class="row" style="justify-content:space-between"><div class="total">
        <div><div class="muted small">Итоговый балл</div><div class="big score ${scoreCls(r.total_score)}">${r.total_score == null ? "—" : f2(r.total_score)}<span class="muted" style="font-size:18px"> / 100</span></div></div>
        ${changed ? `<div><div class="muted small">Оценка ИИ была</div><div style="font-size:22px;font-weight:700">${f2(r.original_total_score)}</div><div class="small muted">после апелляции</div></div>` : ""}
        ${r.total_score == null ? '<div class="badge warn">Нет применимых критериев — итог не рассчитывается</div>' : ""}</div>
        <label style="min-width:230px">Версия оценки<select id="evSel">${c.evaluations.map((e, i) => `<option value="${i}" ${i === S.evalIdx ? "selected" : ""}>#${e.id} · чек-лист v${e.checklist_version} · ${new Date(e.created_at).toLocaleString("ru-RU")}</option>`).join("")}</select></label></div>
        ${humanReviews ? `<div class="msgbox review-alert"><b>Проверить вручную: ${humanReviews} ${humanReviews === 1 ? "критерий" : "критериев"}.</b> Есть низкая уверенность, расхождение при перепроверке или оценка создана до появления этой проверки. Итоговый балл предварительный.</div>` : ""}
        ${r.gross_flag ? `<div class="gross">⚠ ${r.gross_violations.some(g => g.disputed) ? "Возможное грубое нарушение — нужна проверка человека" : "Грубая ошибка выявлена"}: ${r.gross_violations.map(g => esc(g.name)).join(", ")} ${r.gross_violations.map(g => g.evidence ? `<button class="sm danger" data-jump="${g.evidence.index}">реплика #${g.evidence.index}</button>` : "").join(" ")}</div>` : `<div class="grossok">Грубых ошибок не выявлено</div>`}
        <div class="secs">${r.sections.map(s => `<div class="sec"><div class="row" style="justify-content:space-between"><b>${esc(s.name)}</b>
          <span class="small">${s.percent == null ? "N/A" : `${f2(s.points)} из ${f2(s.max_points)} б. · ${f2(s.percent)}%`}</span></div><div class="bar"><i style="width:${s.percent || 0}%"></i></div></div>`).join("")}</div>
        ${r.usage ? `<div class="small muted" style="margin-top:10px">Модель ${esc(r.model || "")} · ${r.usage.prompt_tokens + r.usage.completion_tokens} ток.${r.usage.cost == null ? "" : ` · стоимость оценки ≈ $${Number(r.usage.cost).toFixed(4)}`}</div>` : ""}</div>
      ${r.criteria.map(cr => critHtml(cr, ev, openAppeals)).join("")}`;
  }
  function critHtml(cr, ev, openAppeals) {
    const gross = cr.type === "gross", na = !cr.applicable;
    const cls = gross ? (cr.decision === "YES" ? "bad" : "good") : na ? "na" : cr.points_raw >= cr.weight - 1e-9 ? "good" : cr.points_raw <= 0 ? "bad" : "warn";
    const badge = gross ? (cr.verification?.status === "disagreed" ? `<span class="badge warn">Расхождение · проверьте</span>` : cr.decision === "YES" ? `<span class="badge bad">Нарушение выявлено</span>` : `<span class="badge good">Не выявлено</span>`)
      : na ? `<span class="badge">N/A</span>` : `<span class="badge ${cls}">${decLabel(cr.decision)}</span>`;
    const pts = gross ? "без баллов" : na ? "исключён из расчёта" : `${f2(cr.final_points)} из ${f2(cr.final_max)} б.`;
    const wTxt = gross ? "" : na ? `вес ${cr.weight} перераспределён` : (Math.abs(cr.final_max - cr.weight) > 0.005 ? `вес ${cr.weight} → ${f2(cr.final_max)}` : `вес ${cr.weight}`);
    const e = cr.evidence, seg = cr.checked_segment, tr = S.card.transcript;
    const confidence = cr.human_review_required === false
      ? `<span class="badge good">Уверенность высокая</span>`
      : cr.human_review_required === true
        ? `<span class="badge warn">Низкая уверенность · проверьте</span>`
        : `<span class="badge warn">Уверенность не проверялась</span>`;
    const pending = openAppeals.find(a => String(a.criterion_id) === String(cr.criterion_id) && a.status === "pending");
    const rv = cr.review;
    return `<div class="crit ${cls} ${cr.human_review_required !== false ? "needs-review" : ""}"><div class="head"><div><h4>${esc(cr.criterion_id)}. ${esc(cr.name)}</h4><div class="muted small">${wTxt}${cr.type === "scale" && !na ? ` · ступень ${esc(cr.decision)}` : ""}</div></div>
        <div class="crit-status">${badge}<div class="small muted" style="margin-top:3px">${pts}</div>${confidence}</div></div>
      <p style="margin:8px 0 0">${esc(cr.explanation)}</p>
      ${cr.human_review_required !== false && cr.confidence_reason ? `<p class="review-alert small"><b>Почему нужна проверка:</b> ${esc(cr.confidence_reason)}</p>` : ""}
      ${cr.verification ? `<div class="verification small"><b>Повторная проверка:</b> ${cr.verification.status === "agreed" ? "решение совпало" : `расхождение — перепроверяющий: ${esc(decLabel(cr.verification.decision))}`}${cr.verification.reason ? ` · ${esc(cr.verification.reason)}` : ""}</div>` : ""}
      ${na && cr.na_reason && cr.na_reason !== cr.explanation ? `<p class="small" style="margin:6px 0 0"><b>Почему N/A:</b> ${esc(cr.na_reason)}</p>` : ""}
      ${cr.notes?.map(n => `<div class="small" style="color:var(--warn)">⚠ ${esc(n)}</div>`).join("") || ""}
      ${e ? `<button class="ev" data-jump="${e.index}"><div class="meta">${c2(e)} · реплика #${e.index} · ${esc(SP[e.speaker] || e.speaker)} ${S.card.has_audio ? "· ▶ к месту в записи" : "· к реплике ↗"}</div>
          «${esc(e.quote)}»${e.verified ? "" : `<div class="small muted">цитата модели не найдена дословно — показана реплика целиком</div>`}</button>`
        : (!na && seg ? `<button class="ev seg" data-jump="${seg.from}"><div class="meta">Действие не найдено · проверены реплики #${seg.from}–#${seg.to} (${esc(tsOf(seg.from))} – ${esc(tsOf(seg.to))}) ↗</div>${esc(seg.note || "Весь указанный участок разговора")}</button>`
          : (!na && !gross ? `<div class="small muted" style="margin-top:6px">Проверен весь диалог (#0–#${tr.length - 1})</div>` : ""))}
      ${cr.verification?.evidence ? `<button class="ev" data-jump="${cr.verification.evidence.index}"><div class="meta">Доказательство повторной проверки · реплика #${cr.verification.evidence.index}</div>«${esc(cr.verification.evidence.quote)}»</button>` : ""}
      ${rv ? `<div class="review"><b>Апелляция #${rv.appeal_id ?? ""}:</b> ИИ — <b>${esc(decLabel(rv.ai_decision))}</b> → решение проверяющего: ${rv.decision === "confirm" ? "оценка <b>подтверждена</b>" : `<b>изменена на ${esc(decLabel(rv.final_decision))}</b>`}<br>
          Причина: ${esc(rv.reason)}<br><span class="muted">Финал по критерию: ${esc(decLabel(cr.decision))}</span></div>` : ""}
      ${pending ? `<div class="small" style="margin-top:8px"><span class="badge warn">Апелляция на рассмотрении</span> ${esc(pending.comment)}</div>`
        : `<div style="margin-top:8px"><button class="sec sm" data-appeal="${esc(cr.criterion_id)}">Оспорить критерий</button></div>`}</div>`;
  }
  const tsOf = i => S.card.transcript[i] ? tsLabel(S.card, S.card.transcript[i]) : "";
  const c2 = e => esc(tsLabel(S.card, S.card.transcript[e.index] || { timestamp: e.timestamp }));

  function bindResult() {
    $$("[data-jump]", $("#p-card")).forEach(b => b.onclick = () => jumpTo(Number(b.dataset.jump), { play: true }));
    $$("[data-appeal]", $("#p-card")).forEach(b => b.onclick = () => appealDialog(b.dataset.appeal));
    const sel = $("#evSel"); if (sel) sel.onchange = e => { S.evalIdx = Number(e.target.value); $("#resultBox").innerHTML = resultHtml(S.card.evaluations[S.evalIdx]); bindResult(); };
  }
  function appealDialog(criterionId) {
    const ev = S.card.evaluations[S.evalIdx], cr = ev.result.criteria.find(x => String(x.criterion_id) === String(criterionId)), d = $("#dlg");
    d.innerHTML = `<h3>Оспорить: ${esc(cr.name)}</h3><p class="muted small">Текущая оценка: <b>${cr.applicable ? esc(decLabel(cr.decision)) : "N/A"}</b>. Проверяющий увидит спорный критерий, ваш комментарий и фрагмент диалога.</p>
      <label>Комментарий<textarea id="apText" placeholder="Почему вы не согласны с оценкой?"></textarea></label>
      <div class="row" style="justify-content:flex-end;margin-top:12px"><button class="sec" id="apCancel">Отмена</button><button id="apSend">Отправить апелляцию</button></div>`;
    d.showModal(); $("#apCancel").onclick = () => d.close();
    $("#apSend").onclick = async () => {
      const comment = $("#apText").value.trim(); if (!comment) return $("#apText").focus();
      try { await api("/api/appeals", { method: "POST", body: JSON.stringify({ evaluation_id: ev.id, criterion_id: criterionId, comment }) });
        d.close(); S.appeals = await api("/api/appeals"); $("#resultBox").innerHTML = resultHtml(ev); bindResult(); notice("Апелляция сохранена и ждёт проверяющего (вкладка «Апелляции»)."); }
      catch (e) { notice(e.message, "err"); d.close(); }
    };
  }

  /* ───────── апелляции ───────── */
  async function loadAppeals() {
    S.appeals = await api("/api/appeals"); renderAppeals();
    $("#apCnt").textContent = S.appeals.some(a => a.status === "pending") ? "•" : "";
  }
  function snipHtml(a) {
    return `<div class="snip">${a.snippet.messages.map(m => `<div class="msg ${esc(m.speaker)} ${m.index === a.snippet.focus ? "hl" : ""}"><div class="ts">${esc(a.channel === "voice call" ? "#" + m.index : m.timestamp)}</div><div><span class="sp">${esc(SP[m.speaker] || m.speaker)}</span><span class="idx">#${m.index}</span><div>${esc(m.text)}</div></div></div>`).join("")}</div>`;
  }
  function renderAppeals() {
    const list = S.appeals;
    $("#p-appeals").innerHTML = `<div class="toolbar"><h2>Апелляции</h2><span class="muted">${list.filter(a => a.status === "pending").length} ожидают решения</span></div>` +
      (list.map(a => `<div class="card" data-ap="${a.id}">
        <div class="row" style="justify-content:space-between"><h3>#${a.id} · ${esc(a.conversation_id)} · ${esc(a.criterion_id)}. ${esc(a.criterion_name)}</h3>
          <span class="badge ${a.status === "pending" ? "warn" : "good"}">${a.status === "pending" ? "ожидает решения" : "решено"}</span></div>
        <p class="small muted" style="margin:4px 0">Оценка ИИ: <b>${esc(decLabel(a.original_decision ?? a.ai_decision))}</b> · итог до решения: ${f2(a.total_before)}</p>
        <p style="margin:6px 0"><b>Комментарий:</b> ${esc(a.comment)}</p>
        <div class="small muted">Обоснование ИИ: ${esc(a.explanation || "")}</div>
        ${snipHtml(a)}
        ${a.status === "pending" ? `<div class="f"><label>Решение<select data-nd>${a.allowed_values.map(v => `<option value="${esc(v)}" ${String(v) === String(a.current_decision) ? "selected" : ""}>${esc(decLabel(v))}</option>`).join("")}</select></label>
          <label class="wide">Причина решения<textarea data-rs placeholder="Обязательно: почему подтверждаете или меняете"></textarea></label></div>
          <div class="row"><button data-res="confirm">Подтвердить оценку ИИ</button><button class="sec" data-res="change">Изменить на выбранную</button><button class="sec" data-go>Открыть карточку</button></div>`
        : `<div class="review"><b>Решение:</b> ${a.decision === "confirm" ? "оценка подтверждена" : `изменена: ${esc(decLabel(a.original_decision))} → <b>${esc(decLabel(a.new_decision))}</b>`}<br>
            <b>Причина:</b> ${esc(a.reviewer_reason)}<br><b>Итог:</b> ${f2(a.total_before)} → <b>${f2(a.total_after)}</b></div>
          <div class="row" style="margin-top:8px"><button class="sec sm" data-go>Открыть карточку</button></div>`}</div>`).join("") || `<div class="card muted">Апелляций пока нет. Оспорить критерий можно в карточке диалога.</div>`);
    $$("[data-ap]").forEach(el => {
      const a = list.find(x => x.id === Number(el.dataset.ap));
      const go = $("[data-go]", el); if (go) go.onclick = () => openCard(a.conversation_id, { evalId: a.evaluation_id, jump: a.evidence?.index ?? a.snippet.focus ?? undefined });
      $$("[data-res]", el).forEach(b => b.onclick = async () => {
        const reason = $("[data-rs]", el).value.trim(); if (!reason) { $("[data-rs]", el).focus(); return notice("Укажите причину решения.", "err"); }
        try { const r = await api(`/api/appeals/${a.id}`, { method: "PATCH", body: JSON.stringify({ decision: b.dataset.res, new_decision: $("[data-nd]", el).value, reviewer_reason: reason }) });
          notice(`Решение сохранено. Итог пересчитан: ${f2(r.total_before)} → ${f2(r.total_after)}`); loadAppeals(); }
        catch (e) { notice(e.message, "err"); }
      });
    });
  }

  /* ───────── настройки чек-листа ───────── */
  async function loadSettings() {
    S.versions = await api("/api/checklists");
    if (!S.draft) S.draft = await api("/api/checklist");
    renderSettings();
  }
  const uid = () => String(Date.now()).slice(-6);
  function renderSettings() {
    const d = S.draft, sum = d.criteria.filter(c => c.type !== "gross").reduce((s, c) => s + Number(c.weight || 0), 0);
    $("#p-settings").innerHTML = `
      <div class="toolbar"><h2>Настройка чек-листа</h2><div class="row"><button class="sec" id="reset">Загрузить начальный (v1)</button><button id="save">💾 Сохранить как новую версию</button></div></div>
      <div class="card"><b>Версии</b> <span class="muted small">— новая версия становится активной и применяется при следующей оценке; прежние оценки хранят свой снимок.</span>
        <div class="vers" style="margin-top:8px">${S.versions.map(v => `<button class="sec sm ${v.active ? "cur" : ""}" data-ver="${v.version}" title="${new Date(v.created_at).toLocaleString("ru-RU")}">v${v.version}${v.active ? " ✓ активна" : ""}</button>`).join("")}</div>
        <div class="small muted">Клик по версии — загрузить её в редактор. «Сделать активной» — на загруженной версии ниже.</div></div>
      <div class="card f"><label class="wide">Название<input data-k="name" value="${esc(d.name)}"></label>
        <label class="wide">Общие правила (передаются модели)<textarea data-k="general_rules" style="min-height:90px">${esc(d.general_rules)}</textarea></label></div>
      <div class="card"><b>Секции</b>${d.sections.map((s, i) => `<div class="row" style="margin:6px 0"><input data-sec="${i}" value="${esc(s.name)}" style="max-width:380px"><button class="danger sm" data-delsec="${i}">✕</button></div>`).join("")}
        <button class="sec sm" id="addSec">+ Секция</button></div>
      <div class="row" style="margin:10px 0"><b>Критерии</b><span class="badge ${sum === 100 ? "good" : "warn"}">сумма весов: ${sum}${sum === 100 ? "" : " (итог всё равно нормируется до 100)"}</span></div>
      ${d.criteria.map((c, i) => critEditor(c, i, d)).join("")}
      <button class="sec" id="addCrit">+ Добавить критерий</button>`;
    bindSettings();
  }
  function critEditor(c, i, d) {
    return `<div class="crit-ed" data-i="${i}"><div class="f">
      <label>ID<input data-c="id" value="${esc(c.id)}"></label>
      <label class="wide" style="grid-column:span 2">Название<input data-c="name" value="${esc(c.name)}"></label>
      <label>Секция<select data-c="section">${d.sections.map(s => `<option value="${esc(s.id)}" ${s.id === c.section ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select></label>
      <label>Тип ответа<select data-c="type"><option value="boolean" ${c.type === "boolean" ? "selected" : ""}>Да / Нет</option><option value="scale" ${c.type === "scale" ? "selected" : ""}>Числовая шкала</option><option value="gross" ${c.type === "gross" ? "selected" : ""}>Грубое нарушение (флаг)</option></select></label>
      ${c.type !== "gross" ? `<label>Вес<input type="number" min="0" data-c="weight" value="${c.weight}"></label>` : ""}
      ${c.type !== "gross" ? `<label><br><input type="checkbox" data-c="allow_na" ${c.allow_na ? "checked" : ""}>Разрешить N/A</label>` : ""}
      <label class="wide">Формулировка критерия<textarea data-c="description">${esc(c.description)}</textarea></label>
      ${c.allow_na && c.type !== "gross" ? `<label class="wide">Условие N/A<input data-c="na_condition" value="${esc(c.na_condition || "")}"></label>` : ""}</div>
      ${c.type === "scale" ? `<div class="small muted">Шкала: верхняя ступень даёт полный вес критерия</div><div class="steps">${(c.scale || []).map((s, k) => `<input type="number" data-sv="${k}" value="${s.value}"><input data-sl="${k}" value="${esc(s.label)}" placeholder="Описание ступени"><button class="danger sm" data-delstep="${k}">✕</button>`).join("")}</div><button class="sec sm" data-addstep style="margin-top:6px">+ Ступень</button>` : ""}
      <div class="row" style="margin-top:10px;justify-content:flex-end"><button class="sec sm" data-up ${i === 0 ? "disabled" : ""}>↑</button><button class="sec sm" data-down ${i === d.criteria.length - 1 ? "disabled" : ""}>↓</button><button class="danger sm" data-del>Удалить критерий</button></div></div>`;
  }
  function bindSettings() {
    const d = S.draft, P = $("#p-settings");
    $$("[data-k]", P).forEach(el => el.oninput = () => { d[el.dataset.k] = el.value; });
    $$("[data-sec]", P).forEach(el => el.oninput = () => { d.sections[el.dataset.sec].name = el.value; });
    $$("[data-delsec]", P).forEach(b => b.onclick = () => {
      const s = d.sections[b.dataset.delsec]; if (d.sections.length < 2) return notice("Нужна хотя бы одна секция", "err");
      d.sections.splice(b.dataset.delsec, 1); d.criteria.forEach(c => { if (c.section === s.id) c.section = d.sections[0].id; }); renderSettings(); });
    $("#addSec").onclick = () => { d.sections.push({ id: "s" + uid(), name: "Новая секция" }); renderSettings(); };
    $("#addCrit").onclick = () => { d.criteria.push({ id: String(d.criteria.length + 1 + (d.criteria.some(c => c.id === String(d.criteria.length + 1)) ? uid() : "")), section: d.sections[0].id, name: "Новый критерий", type: "boolean", weight: 10, allow_na: false, description: "Да — …", na_condition: "" }); renderSettings(); };
    $$(".crit-ed", P).forEach(el => {
      const i = Number(el.dataset.i), c = d.criteria[i];
      $$("[data-c]", el).forEach(inp => {
        const k = inp.dataset.c;
        inp.onchange = inp.oninput = () => {
          c[k] = inp.type === "checkbox" ? inp.checked : k === "weight" ? Number(inp.value) : inp.value;
          if (k === "type") { if (c.type === "scale" && !c.scale?.length) c.scale = [{ value: 10, label: "Полностью" }, { value: 5, label: "Частично" }, { value: 0, label: "Нет" }]; if (c.type === "gross") { c.weight = 0; c.allow_na = false; } renderSettings(); }
          if (k === "allow_na") renderSettings();
        };
      });
      $$("[data-sv]", el).forEach(x => x.oninput = () => { c.scale[x.dataset.sv].value = Number(x.value); });
      $$("[data-sl]", el).forEach(x => x.oninput = () => { c.scale[x.dataset.sl].label = x.value; });
      $$("[data-delstep]", el).forEach(x => x.onclick = () => { c.scale.splice(x.dataset.delstep, 1); renderSettings(); });
      const as = $("[data-addstep]", el); if (as) as.onclick = () => { c.scale.push({ value: 0, label: "" }); renderSettings(); };
      $("[data-del]", el).onclick = () => { if (confirm(`Удалить критерий «${c.name}»?`)) { d.criteria.splice(i, 1); renderSettings(); } };
      $("[data-up]", el).onclick = () => { [d.criteria[i - 1], d.criteria[i]] = [d.criteria[i], d.criteria[i - 1]]; renderSettings(); };
      $("[data-down]", el).onclick = () => { [d.criteria[i + 1], d.criteria[i]] = [d.criteria[i], d.criteria[i + 1]]; renderSettings(); };
    });
    $$("[data-ver]", P).forEach(b => b.onclick = async () => {
      S.draft = await api("/api/checklists/" + b.dataset.ver); S.draft.__from = Number(b.dataset.ver); renderSettings();
      if (!S.versions.find(v => v.version === S.draft.__from).active) {
        const act = document.createElement("button"); act.className = "sec sm"; act.textContent = `Сделать v${S.draft.__from} активной`;
        act.onclick = async () => { await api(`/api/checklists/${S.draft.__from}/activate`, { method: "POST" }); notice(`Активна версия v${S.draft.__from}`); loadSettings(); };
        $(".vers", P).appendChild(act);
      }
    });
    $("#reset").onclick = async () => { S.draft = await api("/api/checklists/1"); renderSettings(); notice("Загружен начальный чек-лист (v1). Чтобы применить, сохраните как новую версию."); };
    $("#save").onclick = async () => {
      try { delete d.__from; const saved = await api("/api/checklist", { method: "PUT", body: JSON.stringify(d) });
        S.draft = saved; notice(`Сохранена версия v${saved.version} — она активна и применяется к новым оценкам.`); loadSettings(); }
      catch (e) { notice(e.message, "err"); window.scrollTo(0, 0); }
    };
  }

  /* ───────── старт ───────── */
  (async () => {
    try { await loadHealth(); await loadConvs(); S.appeals = await api("/api/appeals"); $("#apCnt").textContent = S.appeals.some(a => a.status === "pending") ? "•" : ""; }
    catch (e) { notice("Сервер недоступен: " + e.message, "err", 0); }
  })();
})();
