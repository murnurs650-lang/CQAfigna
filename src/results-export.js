const CRITERIA = [
  { id: "1", code: "contact", type: "boolean", weight: 10, allowNa: false },
  { id: "2", code: "discovery", type: "boolean", weight: 15, allowNa: true },
  { id: "3", code: "identification", type: "boolean", weight: 20, allowNa: true },
  { id: "4", code: "consultation", type: "scale", weight: 20, allowNa: true, values: [0, 5, 10, 15, 20] },
  { id: "5", code: "empathy", type: "boolean", weight: 15, allowNa: false },
  { id: "6", code: "dialogue", type: "scale", weight: 15, allowNa: false, values: [0, 4, 7, 10] },
  { id: "7", code: "closure", type: "boolean", weight: 5, allowNa: true },
  { id: "8", code: "critical", type: "gross", weight: 0, allowNa: false }
];

const EXPECTED_RECORD_COUNTS = { dev: 65, prod: 10 };
const SPEC_BY_ID = new Map(CRITERIA.map(criterion => [criterion.id, criterion]));
const SPEC_BY_CODE = new Map(CRITERIA.map(criterion => [criterion.code, criterion]));
const round2 = value => Math.round((value + Number.EPSILON) * 100) / 100;

function requireValid(condition, message) {
  if (!condition) throw new Error(message);
}

function decisionForExport(criterion, spec) {
  if (criterion.applicable === false) {
    requireValid(spec.allowNa, `${spec.code}: N/A запрещён для этого критерия`);
    return null;
  }
  const decision = criterion.decision;
  if (spec.type === "boolean" || spec.type === "gross") {
    if (decision === "YES" || decision === true) return true;
    if (decision === "NO" || decision === false) return false;
    if (decision === "N/A" && spec.allowNa) return null;
    throw new Error(`${spec.code}: ожидалось решение Да/Нет${spec.allowNa ? "/N/A" : ""}`);
  }
  if (decision === "N/A" && spec.allowNa) return null;
  const value = Number(decision);
  requireValid(spec.values.includes(value), `${spec.code}: недопустимое значение шкалы «${decision}»`);
  return value;
}

function evidenceTurnsFor(criterion, transcriptLength, code) {
  const evidence = criterion.evidence;
  if (evidence && evidence.index != null) {
    requireValid(Number.isInteger(evidence.index) && evidence.index >= 0 && evidence.index < transcriptLength,
      `${code}: номер подтверждающей реплики вне транскрипта`);
    return [evidence.index + 1];
  }
  const segment = criterion.checked_segment;
  if (segment) {
    const from = Number(segment.from);
    const to = Number(segment.to);
    requireValid(Number.isInteger(from) && Number.isInteger(to) && from >= 0 && to >= from && to < transcriptLength,
      `${code}: проверенный диапазон реплик вне транскрипта`);
    return Array.from({ length: to - from + 1 }, (_, index) => from + index + 1);
  }
  return [];
}

function validateChecklist(checklist) {
  requireValid(Array.isArray(checklist?.criteria) && checklist.criteria.length === CRITERIA.length,
    "В снимке чек-листа должно быть ровно 8 критериев");
  const seen = new Set();
  for (const definition of checklist.criteria) {
    const spec = SPEC_BY_ID.get(String(definition.id));
    requireValid(spec, `В чек-листе неизвестный ID критерия: ${definition.id}`);
    requireValid(!seen.has(spec.code), `Критерий ${spec.code} повторяется в чек-листе`);
    seen.add(spec.code);
    requireValid(definition.type === spec.type, `${spec.code}: тип критерия не совпадает с форматом экспорта`);
    requireValid(Number(definition.weight) === spec.weight, `${spec.code}: вес не совпадает с форматом экспорта`);
    requireValid(Boolean(definition.allow_na) === spec.allowNa, `${spec.code}: настройка N/A не совпадает с форматом экспорта`);
    if (spec.values) {
      const values = Array.isArray(definition.scale) ? definition.scale.map(step => Number(step.value)) : [];
      requireValid(values.length === spec.values.length && spec.values.every(value => values.includes(value)),
        `${spec.code}: шкала не совпадает с форматом экспорта`);
    }
  }
  requireValid(seen.size === CRITERIA.length, "В чек-листе отсутствует один или несколько обязательных критериев");
}

function buildOkRecord(row) {
  const result = JSON.parse(row.result);
  const checklist = JSON.parse(row.checklist_snapshot);
  const transcript = JSON.parse(row.transcript);
  validateChecklist(checklist);
  requireValid(Array.isArray(transcript), "Транскрипт имеет неверный формат");
  requireValid(Array.isArray(result.criteria) && result.criteria.length === CRITERIA.length,
    "В сохранённой оценке должно быть ровно 8 критериев");

  const byId = new Map();
  for (const criterion of result.criteria) {
    const id = String(criterion.criterion_id);
    requireValid(SPEC_BY_ID.has(id), `Неизвестный ID критерия в оценке: ${id}`);
    requireValid(!byId.has(id), `Критерий ${SPEC_BY_ID.get(id).code} повторяется в оценке`);
    byId.set(id, criterion);
  }
  requireValid(byId.size === CRITERIA.length, "В сохранённой оценке отсутствует один или несколько обязательных критериев");

  const criteria = CRITERIA.map(spec => {
    const source = byId.get(spec.id);
    requireValid(source.type === spec.type, `${spec.code}: тип в оценке не совпадает с чек-листом`);
    const value = decisionForExport(source, spec);
    const rationale = String(source.review?.reason || (value === null ? source.na_reason : "") || source.explanation || "").trim();
    requireValid(rationale.length > 0, `${spec.code}: отсутствует обоснование`);
    return {
      criterion_id: spec.code,
      value,
      rationale,
      evidence_turns: evidenceTurnsFor(source, transcript.length, spec.code)
    };
  });

  const valuesByCode = new Map(criteria.map(criterion => [criterion.criterion_id, criterion.value]));
  const applicable = CRITERIA.filter(spec => spec.weight > 0 && valuesByCode.get(spec.code) !== null);
  const availableWeight = applicable.reduce((sum, spec) => sum + spec.weight, 0);
  requireValid(availableWeight > 0, "Невозможно рассчитать итог: нет применимых критериев с весом");
  const earnedWeight = applicable.reduce((sum, spec) => {
    const value = valuesByCode.get(spec.code);
    return sum + (spec.type === "boolean" ? (value ? spec.weight : 0) : value / Math.max(...spec.values) * spec.weight);
  }, 0);
  const finalScore = round2(earnedWeight / availableWeight * 100);
  requireValid(Number.isFinite(result.total_score) && result.total_score >= 0 && result.total_score <= 100,
    "Итоговая оценка отсутствует или находится вне диапазона 0–100");
  requireValid(round2(result.total_score) === finalScore,
    `Итоговая оценка ${result.total_score} не совпадает с расчётом по критериям (${finalScore})`);
  const criticalFlag = criteria.find(item => item.criterion_id === "critical").value;
  requireValid(typeof result.gross_flag === "boolean" && result.gross_flag === criticalFlag,
    "Флаг грубой ошибки не совпадает с критерием critical");

  return {
    conversation_id: String(row.conversation_id),
    status: "ok",
    criteria,
    score: { final_score: finalScore, critical_flag: criticalFlag }
  };
}

function errorRecord(row, error) {
  const message = String(error?.message || error || "Неизвестная ошибка оценки").trim();
  return {
    conversation_id: String(row.conversation_id),
    status: "error",
    criteria: [],
    score: null,
    error: message || "Неизвестная ошибка оценки"
  };
}

function validateDocument(document, expectedCount) {
  const errors = [];
  const records = document.results;
  if (records.length !== expectedCount) {
    errors.push(`Ожидалось ${expectedCount} записей, получено ${records.length}`);
  }
  const ids = records.map(record => record.conversation_id);
  if (ids.some(id => typeof id !== "string" || !id.trim())) errors.push("У каждой записи должен быть исходный conversation_id");
  const uniqueIds = new Set(ids);
  if (uniqueIds.size !== ids.length) errors.push("В наборе есть повторяющиеся conversation_id");

  for (const record of records) {
    if (record.status === "error") {
      if (record.criteria.length !== 0 || record.score !== null || !record.error) {
        errors.push(`${record.conversation_id}: некорректная запись status=error`);
      }
      continue;
    }
    if (record.status !== "ok" || record.criteria.length !== CRITERIA.length) {
      errors.push(`${record.conversation_id}: для status=ok нужны все 8 критериев`);
      continue;
    }
    const codes = record.criteria.map(criterion => criterion.criterion_id);
    if (new Set(codes).size !== CRITERIA.length || CRITERIA.some(spec => !codes.includes(spec.code))) {
      errors.push(`${record.conversation_id}: отсутствуют коды критериев или есть дубли`);
    }
    for (const criterion of record.criteria) {
      const spec = SPEC_BY_CODE.get(criterion.criterion_id);
      if (!spec || typeof criterion.rationale !== "string" || !criterion.rationale.trim()
        || !Array.isArray(criterion.evidence_turns)
        || criterion.evidence_turns.some(turn => !Number.isInteger(turn) || turn < 1)) {
        errors.push(`${record.conversation_id}: некорректное поле критерия ${criterion.criterion_id}`);
        continue;
      }
      const valid = criterion.value === null
        ? spec.allowNa
        : spec.type === "boolean" || spec.type === "gross"
          ? typeof criterion.value === "boolean"
          : Number.isInteger(criterion.value) && spec.values.includes(criterion.value);
      if (!valid) errors.push(`${record.conversation_id}: некорректное значение критерия ${spec.code}`);
    }
    if (!record.score || !Number.isFinite(record.score.final_score)
      || record.score.final_score < 0 || record.score.final_score > 100
      || typeof record.score.critical_flag !== "boolean"
      || record.score.critical_flag !== record.criteria.find(item => item.criterion_id === "critical")?.value) {
      errors.push(`${record.conversation_id}: некорректный итоговый балл или critical_flag`);
    }
  }
  return errors;
}

function buildResultsExport(rows, { dataset, teamName, configuredModel, expectedCount = EXPECTED_RECORD_COUNTS[dataset] }) {
  const models = new Set();
  const results = rows.map(row => {
    if (!row.result || !row.checklist_snapshot) {
      return errorRecord(row, "Оценка не выполнена или отсутствует в базе данных.");
    }
    try {
      const result = JSON.parse(row.result);
      if (result.model) models.add(String(result.model));
      return buildOkRecord({ ...row, result: JSON.stringify(result) });
    } catch (error) {
      return errorRecord(row, error);
    }
  });
  const modelName = [...models].sort().join(", ") || String(configuredModel || "").trim();
  const document = {
    schema_version: "1.0",
    team_name: String(teamName).trim(),
    model: { mode: "external_api", name: modelName },
    results
  };
  const errors = validateDocument(document, expectedCount);
  return {
    document,
    errors,
    okCount: results.filter(record => record.status === "ok").length,
    errorCount: results.filter(record => record.status === "error").length
  };
}

module.exports = { buildResultsExport, EXPECTED_RECORD_COUNTS, CRITERIA };
