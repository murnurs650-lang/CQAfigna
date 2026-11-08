const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { defaultChecklist, normalizeChecklist } = require("./checklist");

const dir = path.join(__dirname, "..", "data");
fs.mkdirSync(path.join(dir, "audio"), { recursive: true });
const db = new Database(path.join(dir, "cqa.db"));
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS conversations (
  conversation_id TEXT PRIMARY KEY, channel TEXT NOT NULL, language TEXT NOT NULL,
  transcript TEXT NOT NULL, audio_url TEXT, raw_json TEXT, imported_at TEXT
);
CREATE TABLE IF NOT EXISTS evaluations (
  id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL, checklist_version INTEGER NOT NULL,
  checklist_snapshot TEXT NOT NULL, result TEXT NOT NULL, total_score REAL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS appeals (
  id INTEGER PRIMARY KEY AUTOINCREMENT, evaluation_id INTEGER NOT NULL, conversation_id TEXT NOT NULL,
  criterion_id TEXT NOT NULL, original_score REAL NOT NULL, comment TEXT NOT NULL, status TEXT NOT NULL,
  decision TEXT, reviewer_score REAL, reviewer_reason TEXT, created_at TEXT NOT NULL, resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS checklist_versions (
  version INTEGER PRIMARY KEY, data TEXT NOT NULL, created_at TEXT NOT NULL
);
`);

function ensureColumn(table, col, type) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
}
ensureColumn("appeals", "original_decision", "TEXT");
ensureColumn("appeals", "new_decision", "TEXT");
ensureColumn("appeals", "total_before", "REAL");
ensureColumn("appeals", "total_after", "REAL");
ensureColumn("conversations", "audio_transcription_required", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("conversations", "audio_transcribed_at", "TEXT");
ensureColumn("conversations", "dataset", "TEXT");
ensureColumn("conversations", "dataset_group_id", "TEXT");

// До появления маркировки наборов локальная база содержала один полный DEV-набор (65 записей).
const importedConversationCount = db.prepare("SELECT COUNT(*) AS count, SUM(dataset IS NULL) AS unassigned FROM conversations").get();
if (importedConversationCount.count === 65 && importedConversationCount.unassigned === 65) {
  db.prepare("UPDATE conversations SET dataset='dev', dataset_group_id='DEV' WHERE dataset IS NULL").run();
}

// Миграция: чек-лист из старой версии (settings.checklist) → таблица версий
if (!db.prepare("SELECT 1 FROM checklist_versions LIMIT 1").get()) {
  const old = db.prepare("SELECT value FROM settings WHERE key='checklist'").get();
  const base = normalizeChecklist(old ? JSON.parse(old.value) : defaultChecklist);
  // Старый формат без секций/ступеней заменяем на актуальный стартовый чек-лист организаторов
  const legacy = old && !JSON.parse(old.value).sections;
  const first = legacy ? normalizeChecklist(defaultChecklist) : base;
  first.version = 1;
  db.prepare("INSERT INTO checklist_versions(version,data,created_at) VALUES(1,?,?)").run(JSON.stringify(first), new Date().toISOString());
  db.prepare("INSERT INTO settings(key,value) VALUES('active_version','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
}

module.exports = db;
