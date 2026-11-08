const config = require("./config");
const { normalizeDecision } = require("./scoring");

// Для звонков timestamp — ISO; в промпте даём ещё и относительное время от начала записи.
function relSeconds(transcript) {
  const t0 = callStart(transcript);
  return transcript.map(m => {
    const t = Date.parse(m.timestamp);
    return Number.isFinite(t) && t0 != null ? Math.max(0, Math.round((t - t0) / 1000)) : null;
  });
}
function callStart(transcript) {
  const ok = m => Number.isFinite(Date.parse(m.timestamp));
  const k = transcript.findIndex(m => m.speaker === "system" && /запис|жазу|record/i.test(m.text) && ok(m));
  // Если до системной отметки «запись запущена» уже была речь — считаем началом первую реплику.
  const speechBefore = k > 0 && transcript.slice(0, k).some(m => m.speaker !== "system" && ok(m));
  const pick = k >= 0 && !speechBefore ? transcript[k] : transcript.find(ok);
  return pick ? Date.parse(pick.timestamp) : null;
}
const mmss = s => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

function buildMessages({ transcript, language, channel, checklist }) {
  const rel = channel === "voice call" ? relSeconds(transcript) : [];
  const lines = transcript.map((m, i) => ({
    i, t: rel[i] != null ? mmss(rel[i]) : m.timestamp, speaker: m.speaker, text: m.text
  }));

  const system = `Ты — строгий и справедливый аудитор качества клиентского сервиса (Freedom Broker).
Оцениваешь ТОЛЬКО работу оператора (speaker = "operator"). Реплики client, bot и system — контекст (приветствие бота — НЕ приветствие оператора). Если speaker = "unknown" в распознанном аудио, определи роль реплики по её смыслу и контексту диалога; не считай автоматически все реплики речью оператора.
Язык диалога: RU, KZ или EN — оценивай по смыслу на языке диалога. Цитаты НЕ переводи.
${channel === "voice call" ? "Это транскрипт ЗВОНКА, полученный автоматическим распознаванием: возможны ошибки распознавания и скрытые имена вроде [Имя скрыто] — не наказывай оператора за явные ошибки ASR." : "Это текстовый чат."}

ПРАВИЛА
1. Никогда не выдумывай цитаты, события, время и проверки личности. Цитата — точный фрагмент текста одной реплики.
2. Для каждого критерия укажи «evidence_index» (номер реплики i, подтверждающей вывод) и «evidence_quote» (дословная цитата из неё).
3. Если действие ПРОПУЩЕНО — evidence_index = null, evidence_quote = "", а в «checked_from»/«checked_to» укажи диапазон проверенных реплик (номера i), в «checked_note» — что проверялось и какое действие ожидалось.
4. N/A ставь ТОЛЬКО если для критерия allow_na = true и выполнено его условие na_condition. Тогда объясни в «na_reason», какое условие выполнено. «Нет» ≠ N/A: «Нет» — действие требовалось, но пропущено/сделано неверно.
5. boolean → decision "YES" или "NO". scale → decision = ОДНО из допустимых значений шкалы (число). gross → "YES" только если нарушение явно подтверждено репликой, иначе "NO". При нехватке доказательств будь консервативен: не приписывай нарушение.
6. Разделяй консультацию (правильно и полно ли решён запрос) и ведение диалога (ясность и последовательность).
7. Объяснение «explanation» — 1–3 предложения на русском, ссылайся на конкретную реплику.
8. Для каждого критерия укажи «confidence»: "high" или "low". Ставь "low", если доказательство неоднозначно, транскрипт распознан неуверенно, неясна роль говорящего или не хватает контекста. Не завышай уверенность.
9. Критерии оценивай строго по их формулировкам, условиям N/A и шкалам из блока checklist (они могут быть изменены пользователем).

ОБЩИЕ ПРАВИЛА ЧЕК-ЛИСТА
${checklist.general_rules || "—"}

Верни ТОЛЬКО валидный JSON без markdown:
{"criteria":[{"criterion_id":"string","decision":"YES|NO|N/A|<число шкалы>","explanation":"string","confidence":"high|low","confidence_reason":"string","evidence_index":number|null,"evidence_quote":"string","checked_from":number|null,"checked_to":number|null,"checked_note":"string","na_reason":"string"}]}
Нужно вернуть ровно по одному объекту на каждый критерий из checklist.`;

  const user = JSON.stringify({
    dialog: { language, channel },
    checklist: checklist.criteria.map(c => ({
      criterion_id: c.id, name: c.name, type: c.type, weight: c.weight,
      description: c.description, allow_na: c.allow_na, na_condition: c.na_condition || null,
      scale: c.type === "scale" ? c.scale : undefined
    })),
    transcript: lines
  });
  return [{ role: "system", content: system }, { role: "user", content: user }];
}

function contentOf(data) {
  const m = data.choices?.[0]?.message || {};
  let c = m.content;
  if (Array.isArray(c)) c = c.map(p => p.text || p.content || "").join("");
  if (!c && typeof m.reasoning === "string" && m.reasoning.includes("{")) c = m.reasoning; // модель «думала» вместо ответа
  return String(c || "");
}
function pickCriteria(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.criteria)) return parsed.criteria;
  for (const v of Object.values(parsed || {})) {
    if (Array.isArray(v) && v.length && typeof v[0] === "object") return v;
    if (v && typeof v === "object") { const r = pickCriteria(v); if (r) return r; }
  }
  return null;
}
function extractJson(text) {
  let t = String(text || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try { return JSON.parse(t); } catch {}
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
  throw new Error("не JSON");
}

async function callModel(messages, useJsonMode, maxTokens = 4000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 120000);
  try {
    const body = { model: config.model, temperature: 0, max_tokens: maxTokens, messages };
    if (config.aiProvider === "openrouter") body.usage = { include: true };
    if (useJsonMode) body.response_format = { type: "json_object" };
    const r = await fetch(config.chatEndpoint, {
      method: "POST", signal: ctl.signal,
      headers: {
        "Authorization": `Bearer ${config.aiKey}`, "Content-Type": "application/json",
        "HTTP-Referer": `http://localhost:${config.port}`, "X-Title": "CQA Platform"
      },
      body: JSON.stringify(body)
    });
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data };
  } catch (e) {
    throw new Error(e.name === "AbortError" ? "Таймаут ответа модели (120 с)" : `Сеть: ${e.message}`);
  } finally { clearTimeout(timer); }
}

function addUsage(usage, data) {
  const reported = data.usage || {};
  usage.prompt_tokens += reported.prompt_tokens || 0;
  usage.completion_tokens += reported.completion_tokens || 0;
  if (usage.cost != null) usage.cost += Number(reported.cost) || 0;
}

async function requestCriteria(messages, usage, stage, maxTokens = 4000) {
  let parsed = null, lastErr = "", jsonMode = true;
  for (let attempt = 0; attempt < 3 && !parsed; attempt++) {
    const response = await callModel(messages, jsonMode, maxTokens);
    if (!response.ok) {
      const provider = config.aiProvider === "openai" ? "OpenAI" : "OpenRouter";
      const message = response.data?.error?.message || `${provider} HTTP ${response.status}`;
      if (jsonMode && [400, 404, 422].includes(response.status)) { jsonMode = false; lastErr = message; continue; }
      if (response.status === 401) throw new Error(`${provider}: неверный API-ключ (401)`);
      if (response.status === 402) throw new Error(`${provider}: недостаточно средств на балансе (402)`);
      if (response.status === 429 || response.status >= 500) {
        await new Promise(resolve => setTimeout(resolve, 1500 * (attempt + 1)));
        lastErr = message;
        continue;
      }
      throw new Error(`${stage}: ${message}`);
    }

    addUsage(usage, response.data);
    const raw = contentOf(response.data);
    try {
      const list = pickCriteria(extractJson(raw));
      if (!list) throw new Error("в JSON нет списка критериев");
      parsed = list;
    } catch (error) {
      lastErr = `ответ не разобран (${error.message})`;
      console.error(`[${stage}] ${config.model}: ${lastErr}. Начало ответа: ${raw.slice(0, 200)}`);
    }
  }
  if (!parsed) throw new Error(`${stage}: ${lastErr || "модель не вернула корректный JSON"}`);
  return parsed;
}

const norm = s => String(s || "").toLowerCase().replace(/[\s ]+/g, " ").replace(/[.,!?;:"«»'’`()\[\]—–-]/g, "").trim();

function buildEvidence(transcript, idx, quote) {
  const q = norm(quote);
  const valid = Number.isInteger(idx) && idx >= 0 && idx < transcript.length;
  if (q) {
    if (valid && norm(transcript[idx].text).includes(q)) return mk(idx, quote, true);
    const found = transcript.findIndex(m => norm(m.text).includes(q));
    if (found >= 0) return mk(found, quote, true);
  }
  if (valid) return mk(idx, transcript[idx].text.slice(0, 300), false); // цитата модели не найдена → показываем реплику целиком
  return null;
  function mk(i, text, verified) {
    return { index: i, timestamp: transcript[i].timestamp, speaker: transcript[i].speaker, quote: String(text).trim(), verified };
  }
}

function isNaDecision(value) {
  return ["N/A", "NA", "N\\A", "Н/П", "НП", "НЕПРИМЕНИМО"].includes(String(value ?? "").trim().toUpperCase());
}

function isIdentityCriterion(def) {
  return /(идентификац|identity|identification)/i.test(`${def.name} ${def.description}`);
}

function buildReviewMessages({ transcript, language, channel, criteria, generalRules }) {
  const system = `Ты — второй проверяющий качества диалога. Проведи отдельную, независимую проверку ТОЛЬКО перечисленных критериев по исходному транскрипту. Не опирайся на предыдущие оценки: их намеренно нет во входных данных.
Строго следуй описанию критерия и общим правилам. Для YES/нарушения укажи подтверждающую дословную цитату. Если действие отсутствует — не выдумывай цитату, укажи checked_from/checked_to и checked_note. N/A разрешён только при allow_na=true и выполнении na_condition; иначе оцени по существу.
Укажи confidence="low", если текст, роль говорящего или доказательства неоднозначны. Не делай предположений в пользу ни оператора, ни клиента. Верни только JSON:
{"criteria":[{"criterion_id":"string","decision":"YES|NO|N/A|<число шкалы>","confidence":"high|low","confidence_reason":"string","evidence_index":number|null,"evidence_quote":"string","checked_from":number|null,"checked_to":number|null,"checked_note":"string","na_reason":"string"}]}`;
  const user = JSON.stringify({
    dialog: { language, channel },
    general_rules: generalRules || "",
    checklist: criteria.map(def => ({
      criterion_id: def.id, name: def.name, type: def.type, description: def.description,
      allow_na: def.allow_na, na_condition: def.na_condition || null,
      scale: def.type === "scale" ? def.scale : undefined
    })),
    transcript: transcript.map((message, index) => ({
      i: index, speaker: message.speaker, text: message.text
    }))
  });
  return [{ role: "system", content: system }, { role: "user", content: user }];
}

async function evaluateConversation({ transcript, language, channel, checklist }) {
  if (!config.aiKey) {
    throw new Error("Задайте OPENAI_API_KEY или OPENROUTER_API_KEY в файле .env");
  }
  const usage = { prompt_tokens: 0, completion_tokens: 0, cost: config.aiProvider === "openrouter" ? 0 : null };
  const list = await requestCriteria(buildMessages({ transcript, language, channel, checklist }), usage, "evaluate");
  const key = c => String(c?.criterion_id ?? c?.id ?? c?.criterion ?? "").trim();
  const byId = new Map(list.map(c => [key(c), c]));
  const byName = new Map(list.map(c => [String(c?.name || "").trim().toLowerCase(), c]));
  const find = (def, i) => byId.get(String(def.id)) || byName.get(def.name.toLowerCase()) || (list.length === checklist.criteria.length ? list[i] : undefined);
  if (!checklist.criteria.some((d, i) => find(d, i))) throw new Error("Модель вернула JSON, но критерии не удалось сопоставить с чек-листом. Попробуйте другую модель.");
  const lastIdx = transcript.length - 1;
  const criteria = checklist.criteria.map((def, i) => {
    const c = find(def, i);
    if (!c) return {
      criterion_id: def.id, decision: def.type === "gross" ? "NO" : (def.type === "scale" ? 0 : "NO"),
      explanation: "Модель не вернула оценку этого критерия — проверьте вручную.",
      confidence: "low", confidence_reason: "Нет решения модели"
    };
    const evidence = buildEvidence(transcript, Number.isInteger(c.evidence_index) ? c.evidence_index : null, c.evidence_quote);
    const from = Number.isInteger(c.checked_from) ? Math.max(0, c.checked_from) : null;
    const to = Number.isInteger(c.checked_to) ? Math.min(lastIdx, c.checked_to) : null;
    const checked = (from != null || c.checked_note) ? {
      from: from ?? 0, to: to ?? lastIdx, note: String(c.checked_note || ""),
      from_ts: transcript[from ?? 0]?.timestamp || "", to_ts: transcript[to ?? lastIdx]?.timestamp || ""
    } : null;
    return {
      criterion_id: def.id, decision: c.decision ?? c.answer ?? c.score, explanation: String(c.explanation || ""),
      evidence, checked_segment: checked, na_reason: String(c.na_reason || ""),
      confidence: String(c.confidence || "").toLowerCase() === "high" ? "high" : "low",
      confidence_reason: String(c.confidence_reason || "")
    };
  });

  for (const def of checklist.criteria) {
    const criterion = criteria.find(item => String(item.criterion_id) === String(def.id));
    const decision = normalizeDecision(def, criterion.decision);
    const concerns = [];
    if (decision.forcedFromNA) concerns.push("N/A не разрешён для этого критерия.");
    if (decision.applicable && decision.value === "YES" && !criterion.evidence?.verified) {
      concerns.push("Нет подтверждённой дословной цитаты для положительного решения.");
    }
    if (!decision.applicable && !criterion.na_reason.trim()) concerns.push("Не указана причина N/A.");
    if (concerns.length) {
      criterion.confidence = "low";
      criterion.confidence_reason = [criterion.confidence_reason, ...concerns].filter(Boolean).join(" ");
    }
  }

  const decisionsById = new Map(criteria.map(criterion => [String(criterion.criterion_id), criterion]));
  const reviewTargets = checklist.criteria.filter(def => {
    const initial = decisionsById.get(String(def.id));
    return def.type === "gross" || isIdentityCriterion(def) || (initial && isNaDecision(initial.decision));
  });
  if (reviewTargets.length) {
    const reviewed = await requestCriteria(
      buildReviewMessages({ transcript, language, channel, criteria: reviewTargets, generalRules: checklist.general_rules }),
      usage,
      "Короткая перепроверка спорных критериев",
      1200
    );
    const reviewedById = new Map(reviewed.map(item => [String(item?.criterion_id ?? ""), item]));
    for (const def of reviewTargets) {
      const initial = decisionsById.get(String(def.id));
      const second = reviewedById.get(String(def.id));
      if (!second) throw new Error(`Второй проход не вернул критерий «${def.name}». Оценка не сохранена — повторите запрос.`);
      const secondDecision = second.decision ?? second.answer ?? second.score;
      if (secondDecision == null || String(secondDecision).trim() === "") {
        throw new Error(`Второй проход не указал решение по критерию «${def.name}». Оценка не сохранена — повторите запрос.`);
      }
      const firstNormalized = normalizeDecision(def, initial.decision);
      const secondNormalized = normalizeDecision(def, secondDecision);
      const sameDecision = firstNormalized.applicable === secondNormalized.applicable
        && String(firstNormalized.value) === String(secondNormalized.value);
      const secondEvidence = buildEvidence(
        transcript,
        Number.isInteger(second.evidence_index) ? second.evidence_index : null,
        second.evidence_quote
      );
      const initialNaMissingReason = !firstNormalized.applicable && !initial.na_reason;
      const secondNaMissingReason = !secondNormalized.applicable && !String(second.na_reason || "").trim();
      const evidenceNeeded = secondNormalized.applicable && secondNormalized.value === "YES";
      const initialEvidenceNeeded = firstNormalized.applicable && firstNormalized.value === "YES";
      const reviewConfidence = String(second.confidence || "").toLowerCase() === "high" ? "high" : "low";
      const lowConfidence = initial.confidence !== "high" || reviewConfidence !== "high" || !sameDecision
        || (evidenceNeeded && !secondEvidence?.verified) || (initialEvidenceNeeded && !initial.evidence?.verified)
        || initialNaMissingReason || secondNaMissingReason;

      initial.verification = {
        status: sameDecision ? "agreed" : "disagreed",
        decision: secondNormalized.value,
        confidence: reviewConfidence,
        reason: String(second.confidence_reason || second.explanation || ""),
        evidence: secondEvidence
      };
      initial.confidence = lowConfidence ? "low" : "high";
      initial.confidence_reason = lowConfidence
        ? !sameDecision
          ? "Два прохода дали разные решения; требуется проверка человеком. " + String(second.confidence_reason || "")
          : [initial.confidence_reason, second.confidence_reason].filter(Boolean).join(" Второй проход: ")
            || "Доказательств недостаточно, чтобы подтвердить высокую уверенность."
        : String(second.confidence_reason || initial.confidence_reason || "");
    }
  }
  for (const criterion of criteria) {
    criterion.human_review_required = criterion.confidence !== "high";
  }
  if (usage.cost != null) usage.cost = Number(usage.cost.toFixed(6));
  return { criteria, usage, model: config.model };
}

module.exports = { evaluateConversation, callStart };
