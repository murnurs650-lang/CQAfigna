// Начальная конфигурация = чек-лист организаторов (CQA_Chat_Quality_Checklist.pdf).
const sections = [
  { id: "s1", name: "Начало и понимание запроса" },
  { id: "s2", name: "Безопасность и решение" },
  { id: "s3", name: "Ведение и завершение диалога" },
  { id: "s4", name: "Грубые нарушения" }
];

const defaultChecklist = {
  version: 1,
  name: "Чек-лист качества чатов (Freedom Broker)",
  general_rules:
    "Оценивается только работа ОПЕРАТОРА; реплики клиента, бота и системные события — контекст. " +
    "Один чек-лист для RU, KZ и EN. Порог первой реакции — 3 минуты; теги и вложения в оценку не входят. " +
    "«Нет» — действие было нужно, но пропущено или выполнено неверно. N/A — критерий неприменим по своему условию. " +
    "Консультация оценивает правильность и полноту решения, ведение диалога — ясность и последовательность общения.",
  sections,
  criteria: [
    { id: "1", section: "s1", name: "Установление контакта", type: "boolean", weight: 10, allow_na: false,
      description: "Да — оператор поздоровался на языке клиента и представился в первом ответе.", na_condition: "" },
    { id: "2", section: "s1", name: "Выявление потребности", type: "boolean", weight: 15, allow_na: true,
      description: "Да — оператор учёл известные детали и уточнил недостающее до ответа.",
      na_condition: "Данных для ответа хватало с самого начала." },
    { id: "3", section: "s2", name: "Идентификация", type: "boolean", weight: 20, allow_na: true,
      description: "Да — проверка личности подтверждена до раскрытия данных или защищённого действия. Если требовалась проверка личности перед защищённым действием и она не подтверждена в чате — «Нет». Общий вопрос (например, о тарифах) идентификации не требует.",
      na_condition: "Запрос не требовал идентификации." },
    { id: "4", section: "s2", name: "Корректная и полная консультация", type: "scale", weight: 20, allow_na: true,
      description: "Оцените ответ или следующий шаг по шкале. Оценивается, правильно и полно ли решён запрос.",
      na_condition: "Чат закончился до того, как клиент сформулировал запрос.",
      scale: [
        { value: 20, label: "Все существенные вопросы закрыты или дан корректный следующий шаг." },
        { value: 15, label: "Основной вопрос решён, пропущена второстепенная деталь." },
        { value: 10, label: "Часть запроса закрыта, существенный вопрос остался открытым." },
        { value: 5, label: "Есть общая подсказка, но клиенту всё ещё непонятно, как действовать." },
        { value: 0, label: "Ответа по существу нет или ключевая рекомендация ошибочна." }
      ] },
    { id: "5", section: "s3", name: "Эмпатия и клиентоориентированность", type: "boolean", weight: 15, allow_na: false,
      description: "Да — оператор вежлив и, если клиент выразил недовольство или описал неудобство, отреагировал на конкретную проблему.",
      na_condition: "" },
    { id: "6", section: "s3", name: "Управление диалогом, скорость и грамотность", type: "scale", weight: 15, allow_na: false,
      description: "Оцените ясность, порядок ответов и предупреждение об ожидании. Оценивается, насколько понятно и последовательно оператор общался.",
      na_condition: "",
      scale: [
        { value: 10, label: "Ответы ясные и связные. Если было явное ожидание, оператор предупредил." },
        { value: 7, label: "Один заметный сбой, но клиент может понять ответ и продолжить." },
        { value: 4, label: "Клиенту приходится переспрашивать из-за формулировок или порядка ответов." },
        { value: 0, label: "Из-за бессвязных или противоречивых реплик ход диалога непонятен." }
      ] },
    { id: "7", section: "s3", name: "Завершение", type: "boolean", weight: 5, allow_na: true,
      description: "Да — оператор подвёл итог или предложил дальнейшую помощь и попрощался.",
      na_condition: "Чат оборвался до возможности его завершить." },
    { id: "8", section: "s4", name: "Грубые ошибки", type: "gross", weight: 0, allow_na: false,
      description: "Да — выявлено оскорбление клиента, предложение платной услуги в обход компании (перевод денег оператору лично для инвестирования или просьба личного номера клиента для платной консультации в частном порядке; достаточно самого предложения) или раскрытие конфиденциальной информации. Нет — ни одно из трёх не выявлено.",
      na_condition: "" }
  ]
};

const maxStep = c => Math.max(...(c.scale || []).map(s => Number(s.value)));

// Приводит любой (в т.ч. старый) чек-лист к единому виду.
function normalizeChecklist(c) {
  const out = JSON.parse(JSON.stringify(c || defaultChecklist));
  out.sections = Array.isArray(out.sections) && out.sections.length ? out.sections : [{ id: "s1", name: "Основное" }];
  out.general_rules = String(out.general_rules || "");
  out.criteria = (out.criteria || []).map(x => {
    const n = { ...x, id: String(x.id), type: x.type || "boolean", weight: Number(x.weight) || 0,
      allow_na: Boolean(x.allow_na), description: String(x.description || ""), na_condition: String(x.na_condition || ""),
      section: x.section || out.sections[0].id };
    if (n.type === "scale") {
      n.scale = (x.scale || []).map(s => typeof s === "object" ? { value: Number(s.value), label: String(s.label || "") } : { value: Number(s), label: "" })
        .filter(s => Number.isFinite(s.value)).sort((a, b) => b.value - a.value);
      n.max_points = n.scale.length ? maxStep(n) : 0;
    } else if (n.type === "gross") { n.weight = 0; n.max_points = 0; delete n.scale; }
    else { n.max_points = n.weight; delete n.scale; }
    return n;
  });
  return out;
}

function validateChecklist(c) {
  if (!c || !Array.isArray(c.criteria) || c.criteria.length === 0) return "Чек-лист должен содержать хотя бы один критерий";
  const ids = new Set();
  for (const x of c.criteria) {
    if (!x.id || ids.has(String(x.id))) return "ID критериев должны быть уникальными и непустыми";
    ids.add(String(x.id));
    if (!String(x.name || "").trim()) return `У критерия ${x.id} нет названия`;
    if (!String(x.description || "").trim()) return `У критерия «${x.name}» нет формулировки`;
    if (!["boolean", "scale", "gross"].includes(x.type)) return `Неизвестный тип критерия «${x.name}»`;
    if (!Number.isFinite(Number(x.weight)) || Number(x.weight) < 0) return `Вес критерия «${x.name}» должен быть числом ≥ 0`;
    if (x.type === "scale") {
      const vals = (x.scale || []).map(s => Number(typeof s === "object" ? s.value : s));
      if (vals.length < 2 || vals.some(v => !Number.isFinite(v) || v < 0)) return `Шкала «${x.name}»: минимум 2 ступени, значения ≥ 0`;
      if (new Set(vals).size !== vals.length) return `Шкала «${x.name}»: ступени не должны повторяться`;
      if (Math.max(...vals) <= 0) return `Шкала «${x.name}»: максимальная ступень должна быть больше нуля`;
    }
  }
  return null;
}
module.exports = { defaultChecklist, normalizeChecklist, validateChecklist, maxStep };
