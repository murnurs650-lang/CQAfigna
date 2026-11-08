const express = require("express");
const path = require("path");
const config = require("./src/config");
const db = require("./src/db");
const audio = require("./src/audio");
const { transcribeAudioFile } = require("./src/transcription");
const { evaluateConversation, callStart } = require("./src/evaluator");
const { calculateScore, normalizeDecision } = require("./src/scoring");
const { defaultChecklist, normalizeChecklist, validateChecklist } = require("./src/checklist");
const { buildAnalytics } = require("./src/analytics");
const { buildResultsExport, EXPECTED_RECORD_COUNTS } = require("./src/results-export");

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));
const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => res.status(e.statusCode || 500).json({ error: e.message }));

/* ───────── helpers ───────── */
function parseTranscript(value) {
  if (!Array.isArray(value)) return [];
  return value.map(m => ({ timestamp: String(m.timestamp ?? ""), speaker: String(m.speaker ?? "unknown"), text: String(m.text ?? "") }));
}
const activeVersion = () => Number(db.prepare("SELECT value FROM settings WHERE key='active_version'").get()?.value || 1);
function getChecklist(version) {
  const row = db.prepare("SELECT data FROM checklist_versions WHERE version=?").get(version ?? activeVersion());
  return row ? normalizeChecklist(JSON.parse(row.data)) : normalizeChecklist(defaultChecklist);
}
// audio_url содержит подпись доступа — в браузер он не уходит, только флаг и время старта записи.
function publicConversation(row, withTranscript) {
  const transcript = JSON.parse(row.transcript);
  const out = {
    conversation_id: row.conversation_id, channel: row.channel, language: row.language,
    has_audio: Boolean(row.audio_url) || Boolean(audio.cached(row.conversation_id)),
    transcription_required: Boolean(row.audio_transcription_required),
    audio_transcribed_at: row.audio_transcribed_at || null,
    audio_start_ms: row.channel === "voice call" ? callStart(transcript) : null,
    message_count: transcript.length
  };
  if (withTranscript) out.transcript = transcript;
  return out;
}
function allowedValues(def) {
  const v = def.type === "boolean" ? ["YES", "NO"] : def.type === "gross" ? ["YES", "NO"] : def.scale.map(s => s.value);
  if (def.allow_na && def.type !== "gross") v.push("N/A");
  return v;
}

/* ───────── health / import ───────── */
app.get("/api/health", (req, res) => res.json({
  ok: true, aiConfigured: Boolean(config.aiKey) && config.aiKeyFormatValid,
  transcriptionConfigured: Boolean(config.openaiKey) && config.openaiKey.startsWith("sk-"),
  model: config.model, datasetConfigured: Boolean(config.datasetUrl)
}));

app.post("/api/import", wrap(async (req, res) => {
  if (!config.datasetUrl) return res.status(400).json({ error: "Заполните DATASET_API_URL в .env" });
  const dataset = String(req.body?.dataset || "dev").trim().toLowerCase();
  if (!["dev", "prod"].includes(dataset)) return res.status(400).json({ error: "Набор должен быть dev или prod" });
  const requestedGroupId = String(req.body?.group_id || "").trim();
  if (dataset === "prod" && !requestedGroupId) {
    return res.status(400).json({ error: "Для импорта PROD укажите group_id, полученный от организаторов" });
  }
  let payload;
  try {
    const url = new URL(config.datasetUrl);
    if (requestedGroupId) url.searchParams.set("group_id", requestedGroupId);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Организаторский API вернул HTTP ${response.status}`);
    payload = await response.json();
  } catch (e) { return res.status(502).json({ error: e.message }); }
  if (!payload.isSuccess || !Array.isArray(payload.data?.records)) return res.status(502).json({ error: payload.error || "Неожиданный формат ответа API" });
  const records = payload.data.records.filter(record => record?.conversation_id);
  const importedIds = records.map(record => String(record.conversation_id));
  const duplicateIds = importedIds.filter((id, index) => importedIds.indexOf(id) !== index);
  if (duplicateIds.length) return res.status(409).json({ error: `API набора содержит повторяющиеся conversation_id: ${[...new Set(duplicateIds)].join(", ")}` });
  const existingConversation = db.prepare("SELECT dataset FROM conversations WHERE conversation_id=?");
  const datasetCollisions = [...new Set(importedIds)].filter(id => {
    const existing = existingConversation.get(id);
    return existing?.dataset && existing.dataset !== dataset;
  });
  if (datasetCollisions.length) {
    return res.status(409).json({ error: `conversation_id уже принадлежат другому набору; данные не изменены: ${datasetCollisions.join(", ")}` });
  }
  const datasetGroupId = String(payload.data.dataset_group_id || requestedGroupId || dataset.toUpperCase());
  const insert = db.prepare(`
    INSERT INTO conversations(conversation_id, channel, language, transcript, audio_url, raw_json, imported_at, dataset, dataset_group_id)
    VALUES(@conversation_id,@channel,@language,@transcript,@audio_url,@raw_json,@imported_at,@dataset,@dataset_group_id)
    ON CONFLICT(conversation_id) DO UPDATE SET channel=excluded.channel, language=excluded.language,
      transcript=excluded.transcript, audio_url=excluded.audio_url, raw_json=excluded.raw_json,
      imported_at=excluded.imported_at, dataset=excluded.dataset, dataset_group_id=excluded.dataset_group_id`);
  const now = new Date().toISOString();
  let n = 0;
  db.transaction(records => {
    for (const r of records) {
      if (!r.conversation_id) continue;
      insert.run({
        conversation_id: String(r.conversation_id), channel: String(r.channel || "unknown"),
        language: String(r.language || "RU").toUpperCase(), transcript: JSON.stringify(parseTranscript(r.transcript)),
        audio_url: r.audio_url || null, raw_json: JSON.stringify(r), imported_at: now,
        dataset, dataset_group_id: datasetGroupId
      });
      n++;
    }
  })(records);
  res.json({ imported: n, dataset, dataset_group_id: datasetGroupId });
}));

/* ───────── conversations ───────── */
app.get("/api/conversations", (req, res) => {
  const rows = db.prepare(`
    SELECT c.conversation_id, c.channel, c.language, c.audio_url, c.transcript,
      (SELECT e.id FROM evaluations e WHERE e.conversation_id=c.conversation_id ORDER BY e.id DESC LIMIT 1) AS latest_evaluation_id,
      (SELECT e.total_score FROM evaluations e WHERE e.conversation_id=c.conversation_id ORDER BY e.id DESC LIMIT 1) AS total_score,
      (SELECT json_extract(e.result,'$.gross_flag') FROM evaluations e WHERE e.conversation_id=c.conversation_id ORDER BY e.id DESC LIMIT 1) AS gross_flag,
      (SELECT COUNT(*) FROM appeals a WHERE a.conversation_id=c.conversation_id AND a.status='pending') AS pending_appeals
    FROM conversations c ORDER BY c.conversation_id`).all();
  res.json(rows.map(r => ({
    ...publicConversation(r, false), latest_evaluation_id: r.latest_evaluation_id, total_score: r.total_score,
    gross_flag: Boolean(r.gross_flag), pending_appeals: r.pending_appeals
  })));
});

app.delete("/api/evaluations", (req, res) => {
  const clearResults = db.transaction(() => {
    const appeals = db.prepare("DELETE FROM appeals").run().changes;
    const evaluations = db.prepare("DELETE FROM evaluations").run().changes;
    return { appeals, evaluations };
  });
  res.json({ ok: true, ...clearResults() });
});

app.get("/api/analytics", (req, res) => {
  const channel = String(req.query.channel || "").trim();
  const language = String(req.query.language || "").trim();
  const conditions = [];
  const params = [];
  if (channel) {
    conditions.push("c.channel = ?");
    params.push(channel);
  }
  if (language) {
    conditions.push("c.language = ?");
    params.push(language);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = db.prepare(`
    SELECT c.raw_json, c.channel, c.language, e.result, e.checklist_snapshot
    FROM conversations c
    JOIN evaluations e ON e.id=(
      SELECT latest.id FROM evaluations latest
      WHERE latest.conversation_id=c.conversation_id
      ORDER BY latest.id DESC LIMIT 1
    )
    ${where}
    ORDER BY c.conversation_id
  `).all(...params);
  const appealWhere = conditions.length
    ? `WHERE ${conditions.join(" AND ")}`
    : "";
  const appealCounts = db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN a.status = 'pending' THEN 1 ELSE 0 END) AS pending
    FROM appeals a
    JOIN conversations c ON c.conversation_id = a.conversation_id
    ${appealWhere}
  `).get(...params);
  res.json({
    ...buildAnalytics(rows),
    appeal_count: appealCounts.total || 0,
    pending_appeal_count: appealCounts.pending || 0,
    filter_options: {
      channels: db.prepare("SELECT DISTINCT channel FROM conversations ORDER BY channel").all().map(row => row.channel),
      languages: db.prepare("SELECT DISTINCT language FROM conversations ORDER BY language").all().map(row => row.language)
    },
    selected_filters: { channel, language }
  });
});

app.get("/api/export/results", (req, res) => {
  const dataset = String(req.query.dataset || "").trim().toLowerCase();
  if (!["dev", "prod"].includes(dataset)) {
    return res.status(400).json({ error: "Выберите набор dev или prod" });
  }
  const teamName = String(req.query.team_name || "").trim();
  if (!teamName) return res.status(400).json({ error: "Укажите название команды" });

  const rows = db.prepare(`
    SELECT c.conversation_id, c.transcript, e.result, e.checklist_snapshot
    FROM conversations c
    LEFT JOIN evaluations e ON e.id=(
      SELECT latest.id FROM evaluations latest
      WHERE latest.conversation_id=c.conversation_id
      ORDER BY latest.id DESC LIMIT 1
    )
    WHERE c.dataset=?
    ORDER BY c.conversation_id
  `).all(dataset);
  const exported = buildResultsExport(rows, {
    dataset,
    teamName,
    configuredModel: config.model,
    expectedCount: EXPECTED_RECORD_COUNTS[dataset]
  });
  if (exported.errors.length) {
    return res.status(422).json({
      error: "Экспорт остановлен: проверки не пройдены",
      errors: exported.errors,
      actual_count: rows.length,
      expected_count: EXPECTED_RECORD_COUNTS[dataset],
      ok_count: exported.okCount,
      error_count: exported.errorCount
    });
  }
  res.set("X-Export-Count", String(exported.document.results.length));
  res.set("X-Export-Errors", String(exported.errorCount));
  res.set("Content-Disposition", 'attachment; filename="results.json"');
  res.type("application/json; charset=utf-8").send(JSON.stringify(exported.document, null, 2));
});

app.get("/api/conversations/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM conversations WHERE conversation_id=?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Диалог не найден" });
  const evals = db.prepare("SELECT id, checklist_version, result, total_score, created_at FROM evaluations WHERE conversation_id=? ORDER BY id DESC").all(req.params.id);
  res.json({ ...publicConversation(row, true), evaluations: evals.map(e => ({ ...e, result: JSON.parse(e.result) })) });
});

// Аудио: отдаём файл с поддержкой Range (перемотка) — см. src/audio.js
app.get("/api/conversations/:id/audio", async (req, res) => {
  const row = db.prepare("SELECT conversation_id, audio_url FROM conversations WHERE conversation_id=?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Диалог не найден" });
  try {
    const file = await audio.getAudioFile(row.conversation_id, row.audio_url);
    res.sendFile(file, { acceptRanges: true, headers: { "Cache-Control": "private, max-age=3600" } });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
// Резервный вариант: если ссылка организаторов не открывается — можно загрузить файл записи вручную.
app.post("/api/conversations/:id/audio", express.raw({ type: () => true, limit: "300mb" }), wrap(async (req, res) => {
  const row = db.prepare("SELECT 1 FROM conversations WHERE conversation_id=?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Диалог не найден" });
  if (!Buffer.isBuffer(req.body) || req.body.length < 1000) return res.status(400).json({ error: "Пустой файл" });
  audio.saveUpload(req.params.id, req.body, decodeURIComponent(req.get("x-filename") || ""));
  db.prepare("UPDATE conversations SET channel='voice call', audio_transcription_required=1, audio_transcribed_at=NULL WHERE conversation_id=?").run(req.params.id);
  res.json({ ok: true });
}));
app.post("/api/conversations/:id/transcribe", wrap(async (req, res) => {
  const row = db.prepare("SELECT conversation_id, language, audio_url FROM conversations WHERE conversation_id=?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Диалог не найден" });
  const file = await audio.getAudioFile(row.conversation_id, row.audio_url);
  const transcript = await transcribeAudioFile(file, row.language);
  const at = new Date().toISOString();
  db.prepare(`UPDATE conversations SET transcript=?, channel='voice call', audio_transcription_required=0,
    audio_transcribed_at=? WHERE conversation_id=?`).run(JSON.stringify(transcript), at, req.params.id);
  res.json({ ok: true, transcript, message_count: transcript.length });
}));

/* ───────── checklists (версионирование) ───────── */
app.get("/api/checklist", (req, res) => res.json(getChecklist()));
app.get("/api/checklists", (req, res) => {
  const act = activeVersion();
  res.json(db.prepare("SELECT version, data, created_at FROM checklist_versions ORDER BY version DESC").all()
    .map(r => ({ version: r.version, name: JSON.parse(r.data).name, created_at: r.created_at, active: r.version === act,
      criteria: JSON.parse(r.data).criteria.length })));
});
app.get("/api/checklists/:v", (req, res) => {
  const row = db.prepare("SELECT data FROM checklist_versions WHERE version=?").get(Number(req.params.v));
  if (!row) return res.status(404).json({ error: "Версия не найдена" });
  res.json(normalizeChecklist(JSON.parse(row.data)));
});
app.put("/api/checklist", (req, res) => {
  const problem = validateChecklist(req.body);
  if (problem) return res.status(400).json({ error: problem });
  const next = (db.prepare("SELECT MAX(version) v FROM checklist_versions").get().v || 0) + 1;
  const checklist = normalizeChecklist({ ...req.body, version: next });
  checklist.version = next;
  db.transaction(() => {
    db.prepare("INSERT INTO checklist_versions(version,data,created_at) VALUES(?,?,?)").run(next, JSON.stringify(checklist), new Date().toISOString());
    db.prepare("INSERT INTO settings(key,value) VALUES('active_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(next));
  })();
  res.json(checklist);
});
app.post("/api/checklists/:v/activate", (req, res) => {
  if (!db.prepare("SELECT 1 FROM checklist_versions WHERE version=?").get(Number(req.params.v))) return res.status(404).json({ error: "Версия не найдена" });
  db.prepare("INSERT INTO settings(key,value) VALUES('active_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(Number(req.params.v)));
  res.json(getChecklist());
});

/* ───────── evaluation ───────── */
app.post("/api/evaluate/:id", wrap(async (req, res) => {
  if (!config.aiKey) return res.status(400).json({ error: "Задайте OPENAI_API_KEY или OPENROUTER_API_KEY в .env и перезапустите сервер" });
  if (!config.aiKeyFormatValid) return res.status(400).json({ error: "OPENAI_API_KEY в .env не похож на секретный API-ключ OpenAI (обычно начинается с sk-). Скопируйте полный API key из кабинета OpenAI." });
  const row = db.prepare("SELECT * FROM conversations WHERE conversation_id=?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Диалог не найден" });
  const version = req.body?.checklist_version ? Number(req.body.checklist_version) : activeVersion();
  if (!db.prepare("SELECT 1 FROM checklist_versions WHERE version=?").get(version)) return res.status(404).json({ error: "Версия чек-листа не найдена" });
  const checklist = getChecklist(version);
  try {
    if (row.audio_transcription_required) {
      return res.status(409).json({ error: "Сначала распознайте загруженное аудио и создайте транскрипт" });
    }
    const transcript = JSON.parse(row.transcript);
    if (!transcript.some(message => message.text.trim())) {
      return res.status(400).json({ error: "Нет транскрипта для оценки. Сначала распознайте аудио или добавьте текст диалога" });
    }
    const ai = await evaluateConversation({ transcript, language: row.language, channel: row.channel, checklist });
    const result = calculateScore(ai, checklist);
    const info = db.prepare(`INSERT INTO evaluations(conversation_id, checklist_version, checklist_snapshot, result, total_score, created_at)
      VALUES(?,?,?,?,?,?)`).run(row.conversation_id, version, JSON.stringify(checklist), JSON.stringify(result), result.total_score, new Date().toISOString());
    res.json({ id: info.lastInsertRowid, checklist_version: version, ...result });
  } catch (e) { res.status(502).json({ error: e.message }); }
}));

/* ───────── appeals ───────── */
function snippetFor(transcript, c) {
  let from = 0, to = Math.min(transcript.length - 1, 5), focus = null;
  if (c?.evidence?.index != null) { focus = c.evidence.index; from = Math.max(0, focus - 3); to = Math.min(transcript.length - 1, focus + 3); }
  else if (c?.checked_segment) { from = c.checked_segment.from; to = Math.min(c.checked_segment.to, from + 7); }
  return { focus, messages: transcript.slice(from, to + 1).map((m, k) => ({ index: from + k, ...m })) };
}
function enrichAppeal(a) {
  const ev = db.prepare("SELECT result, checklist_snapshot FROM evaluations WHERE id=?").get(a.evaluation_id);
  const conv = db.prepare("SELECT * FROM conversations WHERE conversation_id=?").get(a.conversation_id);
  const result = ev ? JSON.parse(ev.result) : null;
  const c = result?.criteria?.find(x => String(x.criterion_id) === String(a.criterion_id));
  const def = ev ? normalizeChecklist(JSON.parse(ev.checklist_snapshot)).criteria.find(x => String(x.id) === String(a.criterion_id)) : null;
  const transcript = conv ? JSON.parse(conv.transcript) : [];
  return {
    ...a, criterion_name: c?.name || def?.name || a.criterion_id, criterion_type: c?.type, weight: c?.weight,
    current_decision: c?.decision, ai_decision: c?.ai_decision, explanation: c?.explanation, evidence: c?.evidence || null,
    allowed_values: def ? allowedValues(def) : [], current_total: result?.total_score ?? null,
    channel: conv?.channel, language: conv?.language, snippet: snippetFor(transcript, c)
  };
}
app.get("/api/appeals", (req, res) => {
  res.json(db.prepare("SELECT * FROM appeals ORDER BY (status='pending') DESC, id DESC").all().map(enrichAppeal));
});
app.post("/api/appeals", (req, res) => {
  const { evaluation_id, criterion_id, comment } = req.body || {};
  if (!evaluation_id || !criterion_id || !String(comment || "").trim()) return res.status(400).json({ error: "Нужны evaluation_id, criterion_id и комментарий" });
  const ev = db.prepare("SELECT * FROM evaluations WHERE id=?").get(evaluation_id);
  if (!ev) return res.status(404).json({ error: "Оценка не найдена" });
  const result = JSON.parse(ev.result);
  const c = result.criteria.find(x => String(x.criterion_id) === String(criterion_id));
  if (!c) return res.status(404).json({ error: "Критерий не найден в оценке" });
  if (db.prepare("SELECT 1 FROM appeals WHERE evaluation_id=? AND criterion_id=? AND status='pending'").get(evaluation_id, String(criterion_id)))
    return res.status(409).json({ error: "По этому критерию уже есть необработанная апелляция" });
  const info = db.prepare(`INSERT INTO appeals(evaluation_id, conversation_id, criterion_id, original_score, original_decision, comment, status, total_before, created_at)
    VALUES(?,?,?,?,?,?,'pending',?,?)`).run(evaluation_id, ev.conversation_id, String(criterion_id), c.points, String(c.decision),
    String(comment).trim(), result.total_score, new Date().toISOString());
  res.json({ id: info.lastInsertRowid, status: "pending" });
});
app.patch("/api/appeals/:id", (req, res) => {
  const { decision, new_decision, reviewer_reason } = req.body || {};
  if (!["confirm", "change"].includes(decision)) return res.status(400).json({ error: "decision должен быть confirm или change" });
  if (!String(reviewer_reason || "").trim()) return res.status(400).json({ error: "Укажите причину решения" });
  const appeal = db.prepare("SELECT * FROM appeals WHERE id=?").get(req.params.id);
  if (!appeal) return res.status(404).json({ error: "Апелляция не найдена" });
  if (appeal.status !== "pending") return res.status(409).json({ error: "Апелляция уже рассмотрена" });
  const ev = db.prepare("SELECT * FROM evaluations WHERE id=?").get(appeal.evaluation_id);
  const checklist = normalizeChecklist(JSON.parse(ev.checklist_snapshot));
  const def = checklist.criteria.find(x => String(x.id) === String(appeal.criterion_id));
  const result = JSON.parse(ev.result);
  const c = result.criteria.find(x => String(x.criterion_id) === String(appeal.criterion_id));
  let final = c.decision;
  if (decision === "change") {
    const ok = allowedValues(def).map(String);
    if (!ok.includes(String(new_decision))) return res.status(400).json({ error: `Допустимые значения: ${ok.join(", ")}` });
    final = normalizeDecision(def, new_decision).value;
  }
  const before = result.total_score;
  c.review = {
    decision, ai_decision: c.ai_decision, previous_decision: c.decision, final_decision: final,
    reason: String(reviewer_reason).trim(), appeal_id: appeal.id, at: new Date().toISOString()
  };
  const updated = calculateScore({ criteria: result.criteria, usage: result.usage, model: result.model }, checklist);
  db.transaction(() => {
    db.prepare("UPDATE evaluations SET result=?, total_score=? WHERE id=?").run(JSON.stringify(updated), updated.total_score, ev.id);
    db.prepare(`UPDATE appeals SET status='resolved', decision=?, new_decision=?, reviewer_score=?, reviewer_reason=?, total_before=?, total_after=?, resolved_at=? WHERE id=?`)
      .run(decision, String(final), updated.criteria.find(x => String(x.criterion_id) === String(appeal.criterion_id)).points,
        String(reviewer_reason).trim(), before, updated.total_score, new Date().toISOString(), appeal.id);
  })();
  res.json({ ok: true, total_before: before, total_after: updated.total_score, updated_result: updated });
});

app.listen(config.port, () => {
  console.log(`CQA запущен: http://localhost:${config.port}`);
  console.log(config.aiKey ? `AI: ${config.aiProvider}, модель ${config.model}` : "⚠ Не задан API-ключ для оценки: OPENAI_API_KEY или OPENROUTER_API_KEY");
  if (!config.openaiKey || !config.openaiKey.startsWith("sk-")) console.log("⚠ OPENAI_API_KEY отсутствует или имеет неверный формат — распознавание аудио отключено");
  if (!config.aiKeyFormatValid) console.log("⚠ OPENAI_API_KEY имеет неверный формат — оценка не будет работать");
});
