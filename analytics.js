const OPERATOR_ID_KEYS = ["operator_id", "operatorId", "agent_id", "agentId", "employee_id", "employeeId"];
const OPERATOR_NAME_KEYS = ["operator_name", "operatorName", "agent_name", "agentName", "employee_name", "employeeName", "user_name", "userName"];

function firstValue(source, keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === "string" || typeof value === "number") {
      const text = String(value).trim();
      if (text) return text;
    }
  }
  return "";
}

function operatorFor(raw) {
  const record = raw || {};
  const operator = record.operator && typeof record.operator === "object" ? record.operator : {};
  const agent = record.agent && typeof record.agent === "object" ? record.agent : {};
  const id = firstValue(record, OPERATOR_ID_KEYS) || firstValue(operator, ["id", "operator_id", "operatorId"]) ||
    firstValue(agent, ["id", "agent_id", "agentId"]);
  const name = firstValue(record, OPERATOR_NAME_KEYS) ||
    firstValue(operator, ["name", "full_name", "fullName", "display_name", "displayName"]) ||
    firstValue(agent, ["name", "full_name", "fullName", "display_name", "displayName"]) ||
    (typeof record.operator === "string" ? record.operator.trim() : "") ||
    (typeof record.agent === "string" ? record.agent.trim() : "");
  if (!id && !name) return null;
  return { id: id || name.toLocaleLowerCase(), name: name || `Оператор ${id}` };
}

function emptySummary() {
  return {
    evaluations: 0,
    average_score: null,
    gross_error_dialogs: 0,
    gross_error_count: 0,
    score_distribution: Array.from({ length: 10 }, (_, index) => ({
      label: index === 9 ? "90–100" : `${index * 10}–<${(index + 1) * 10}`,
      min: index * 10,
      max: index === 9 ? 101 : (index + 1) * 10,
      count: 0
    })),
    criteria: [],
    sections: [],
    most_failed_criterion: null
  };
}

function summarize(items) {
  const summary = emptySummary();
  const criteria = new Map();
  const sections = new Map();
  let scoreSum = 0, scoreCount = 0;

  for (const item of items) {
    const result = item.result;
    summary.evaluations++;
    if (Number.isFinite(result.total_score)) {
      scoreSum += result.total_score;
      scoreCount++;
      const bucket = summary.score_distribution.find(bin => result.total_score >= bin.min && result.total_score < bin.max);
      if (bucket) bucket.count++;
    }

    for (const section of result.sections || []) {
      if (!Number.isFinite(section.percent)) continue;
      const key = `${section.id}\u0000${section.name}`;
      if (!sections.has(key)) sections.set(key, {
        id: String(section.id),
        name: String(section.name),
        score_sum: 0,
        score_count: 0
      });
      const stat = sections.get(key);
      stat.score_sum += section.percent;
      stat.score_count++;
    }

    const violations = Array.isArray(result.gross_violations) ? result.gross_violations : [];
    if (result.gross_flag || violations.length) summary.gross_error_dialogs++;
    summary.gross_error_count += violations.length || (result.gross_flag ? 1 : 0);

    const definitions = new Map((item.checklist.criteria || []).map(def => [String(def.id), def]));
    for (const criterion of result.criteria || []) {
      if (criterion.type === "gross" || criterion.applicable === false) continue;
      const key = `${criterion.criterion_id}\u0000${criterion.name}`;
      if (!criteria.has(key)) {
        criteria.set(key, {
          criterion_id: String(criterion.criterion_id),
          name: String(criterion.name || criterion.criterion_id),
          type: criterion.type,
          applicable_count: 0,
          failure_count: 0,
          score_sum: 0,
          score_count: 0
        });
      }
      const stat = criteria.get(key);
      stat.applicable_count++;
      const weight = Number(criterion.weight);
      const points = Number(criterion.points_raw ?? criterion.points);
      if (weight > 0 && Number.isFinite(points)) {
        stat.score_sum += Math.max(0, Math.min(100, points / weight * 100));
        stat.score_count++;
      }
      const definition = definitions.get(String(criterion.criterion_id));
      const scale = Array.isArray(definition?.scale) ? definition.scale.map(step => Number(step.value)).filter(Number.isFinite) : [];
      const decision = Number(criterion.decision);
      const failed = criterion.type === "boolean"
        ? criterion.decision === "NO"
        : criterion.type === "scale" && scale.length > 0 && Number.isFinite(decision)
          ? decision === Math.min(...scale)
          : false;
      if (failed) stat.failure_count++;
    }
  }

  summary.average_score = scoreCount ? Math.round((scoreSum / scoreCount + Number.EPSILON) * 100) / 100 : null;
  summary.criteria = [...criteria.values()].map(stat => ({
    criterion_id: stat.criterion_id,
    name: stat.name,
    average_score: stat.score_count ? Math.round((stat.score_sum / stat.score_count + Number.EPSILON) * 100) / 100 : null,
    failure_count: stat.failure_count,
    applicable_count: stat.applicable_count,
    failure_rate: stat.applicable_count ? Math.round((stat.failure_count / stat.applicable_count + Number.EPSILON) * 10000) / 100 : 0
  })).sort((a, b) => b.failure_rate - a.failure_rate || b.failure_count - a.failure_count || a.name.localeCompare(b.name, "ru"));
  summary.sections = [...sections.values()].map(stat => ({
    id: stat.id,
    name: stat.name,
    average_score: Math.round((stat.score_sum / stat.score_count + Number.EPSILON) * 100) / 100,
    scored_conversations: stat.score_count
  }));
  summary.most_failed_criterion = summary.criteria.find(criterion => criterion.applicable_count > 0) || null;
  return summary;
}

function buildAnalytics(rows) {
  const allItems = [];
  const operatorItems = new Map();
  for (const row of rows) {
    const result = JSON.parse(row.result);
    const checklist = JSON.parse(row.checklist_snapshot);
    const raw = row.raw_json ? JSON.parse(row.raw_json) : {};
    const item = { result, checklist, operator: operatorFor(raw), channel: row.channel, language: row.language };
    allItems.push(item);
    if (item.operator) {
      if (!operatorItems.has(item.operator.id)) operatorItems.set(item.operator.id, { operator: item.operator, items: [] });
      operatorItems.get(item.operator.id).items.push(item);
    }
  }

  const operators = [...operatorItems.values()].map(group => ({
    ...group.operator,
    ...summarize(group.items)
  })).sort((a, b) => (b.average_score ?? -1) - (a.average_score ?? -1) || a.name.localeCompare(b.name, "ru"));

  return {
    evaluated_conversations: allItems.length,
    operator_data_available: operators.length > 0,
    unassigned_operator_conversations: allItems.length - [...operatorItems.values()].reduce((count, group) => count + group.items.length, 0),
    operator_identifier_note: operators.length
      ? ""
      : "В импортированных данных нет имени или ID оператора. Показывается общая аналитика; для рейтинга операторов нужен идентификатор в источнике данных.",
    overall: summarize(allItems),
    operators
  };
}

module.exports = { buildAnalytics };
