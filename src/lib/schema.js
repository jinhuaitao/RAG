// 表结构的唯一来源：Worker 的初始化端点与 CLI 迁移脚本都用它（scripts/dump-schema.mjs 会导出成 schema.sql）
export const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT 'paste',
  char_count INTEGER NOT NULL DEFAULT 0,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`,
  `CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  content TEXT NOT NULL,
  char_count INTEGER NOT NULL DEFAULT 0
)`,
  "CREATE INDEX IF NOT EXISTS chunks_doc_id_idx ON chunks(doc_id)",
];

export const SCHEMA_SQL = `${SCHEMA_STATEMENTS.map((sql) => `${sql};`).join("\n\n")}\n`;
