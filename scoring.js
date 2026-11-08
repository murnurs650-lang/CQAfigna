const { normalizeChecklist, maxStep } = require("./checklist");

const round2 = n => Math.round((n + Number.EPSILON) * 100) / 100;

// Приводит ответ модели/проверяющего к виду { applicable, value }.
function normalizeDecision(def, raw) {
  const s = String(raw ?? "").trim().toUpperCase();
  const isNA = ["N/A", "NA", "N\\A", "Н/П", "НП", "НЕПРИМЕНИМО"].includes(s);
  if (def.type === "gross") return { applicable: true, value: ["YES", "ДА", "TRUE", "1"].includes(s) ? "YES" : "NO" };
  if (isNA) {
    if (def.allow_na) return { applicable: false, value: "N/A" };
    return { applicable: true, value: def.type === "scale" ? Math.min(...def.scale.map(x => x.value)) : "NO", forcedFromNA: true };
  }
  if (def.type === "boolean") return { applicable: true, value: ["YES", "ДА", "TRUE", "1"].includes(s) ? "YES" : "NO" };
  // scale: ближайшая допустимая ступень
  let n = Number(String(raw).replace(",", "."));
  if (!Number.isFinite(n)) n = 0;
  const steps = def.scale.map(x => x.value);
  const nearest = steps.reduce((a, b) => Math.abs(b - n) < Math.abs(a - n) ? b : a, steps[0]);
  return { applicable: true, value: nearest };
}

/**
 * Расчёт по правилам чек-листа:
 *  1) «Да» = полный вес, «Нет» = 0, шкала = ступень / максимальная ступень × вес;
 *  2) критерии с N/A исключаются, их вес перераспределяется пропорционально;
 *  3) итог = набранное / вес применимых × 100, округление до 2 знаков;
 *  4) нет применимых критериев с весом → итог не рассчитывается (null);
 *  5) грубая ошибка — отдельный флаг, на итог не влияет.
 * Если у критерия есть review (решение проверяющего), используется оно; решение ИИ хранится в ai_decision.
 */
function calculateScore(aiResult, checklistIn) {
  const checklist = normalizeChecklist(checklistIn);
  const supplied = Array.isArray(aiResult.criteria) ? aiResult.criteria : [];
  const byId = new Map(supplied.map(x => [String(x.criterion_id), x]));

  const criteria = checklist.criteria.map(def => {
    const a = byId.get(String(def.id)) || {};
    const aiDecision = a.ai_decision ?? a.decision;
    const ai = normalizeDecision(def, aiDecision);
    const eff = a.review ? normalizeDecision(def, a.review.final_decision) : ai;
    let points = 0;
    if (def.type !== "gross" && eff.applicable) {
      points = def.type === "boolean" ? (eff.value === "YES" ? def.weight : 0) : eff.value / maxStep(def) * def.weight;
    }
    const notes = [];
    if (ai.forcedFromNA) notes.push("Модель указала N/A, но для этого критерия N/A не разрешён — засчитан как «Нет»/минимальная ступень.");
    return {
      criterion_id: def.id, name: def.name, section: def.section, type: def.type,
      weight: def.type === "gross" ? 0 : def.weight, allow_na: def.allow_na, max_points: def.type === "gross" ? 0 : def.max_points,
      applicable: eff.applicable, decision: eff.value, ai_decision: ai.value,
      points: round2(points), points_raw: points,
      explanation: String(a.explanation || "Модель не предоставила объяснение."),
      evidence: a.evidence || null,
      checked_segment: a.checked_segment || null,
      na_reason: a.na_reason || (eff.applicable ? "" : String(a.explanation || "")),
      confidence: a.confidence === "high" ? "high" : "low",
      confidence_reason: String(a.confidence_reason || ""),
      human_review_required: a.human_review_required !== false,
      verification: a.verification || null,
      notes, review: a.review || null
    };
  });

  const scored = criteria.filter(c => c.type !== "gross" && c.applicable);
  const activeWeight = scored.reduce((s, c) => s + c.weight, 0);
  const earned = scored.reduce((s, c) => s + c.points_raw, 0);
  const total = activeWeight > 0 ? round2(earned / activeWeight * 100) : null;

  // Баллы после перераспределения весов (максимум = 100)
  for (const c of criteria) {
    if (c.type === "gross") { c.final_points = null; c.final_max = null; continue; }
    c.final_max = c.applicable && activeWeight > 0 ? round2(c.weight / activeWeight * 100) : 0;
    c.final_points = c.applicable && activeWeight > 0 ? round2(c.points_raw / activeWeight * 100) : 0;
  }

  const sectionsOut = checklist.sections.map(s => {
    const own = criteria.filter(c => c.section === s.id && c.type !== "gross");
    if (!own.length) return null;
    const act = own.filter(c => c.applicable);
    const w = act.reduce((x, c) => x + c.weight, 0);
    const e = act.reduce((x, c) => x + c.points_raw, 0);
    return {
      id: s.id, name: s.name,
      percent: w > 0 ? round2(e / w * 100) : null,
      points: activeWeight > 0 ? round2(e / activeWeight * 100) : 0,
      max_points: activeWeight > 0 ? round2(w / activeWeight * 100) : 0,
      applicable: act.length, total: own.length
    };
  }).filter(Boolean);

  const gross = criteria.filter(c => c.type === "gross"
    && (c.decision === "YES" || c.verification?.decision === "YES")).map(c => ({
    criterion_id: c.criterion_id, name: c.name, explanation: c.explanation,
    evidence: c.evidence || c.verification?.evidence || null,
    disputed: c.verification?.status === "disagreed"
  }));

  // Итог по решениям ИИ без пересмотров — для сравнения «было → стало»
  let originalTotal = total;
  if (!aiResult._noReview && supplied.some(x => x.review)) {
    originalTotal = calculateScore({ ...aiResult, _noReview: true, criteria: supplied.map(c => ({ ...c, review: null })) }, checklist).total_score;
  }

  return {
    schema: 2,
    total_score: total,
    original_total_score: originalTotal,
    active_weight: activeWeight,
    gross_flag: gross.length > 0,
    gross_violations: gross,
    sections: sectionsOut,
    criteria,
    usage: aiResult.usage || null,
    model: aiResult.model || null
  };
}
module.exports = { calculateScore, normalizeDecision, round2 };
