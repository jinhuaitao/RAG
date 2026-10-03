import { d1 } from "./cfapi.js";
import { HttpError } from "./http.js";
import { keywordSql } from "./rank.js";

let cachedUuid = null;

export function resetDatabaseCache() {
  cachedUuid = null;
}

export async function databaseUuid(env) {
  if (cachedUuid) return cachedUuid;
  const databases = await d1.listDatabases(env);
  const found = databases.find((database) => database.name === env.DB_NAME);
  if (!found) {
    throw new HttpError(503, `账号下还没有 D1 数据库 ${env.DB_NAME}`, {
      hint: "在页面点“初始化资源”，或调用 POST /api/admin/setup（会自动建库、建表、建向量索引）",
    });
  }
  cachedUuid = found.uuid;
  return cachedUuid;
}

async function run(env, sql, params = []) {
  const uuid = await databaseUuid(env);
  return d1.query(env, uuid, sql, params);
}

// 一次 POST 能带多少语句受三个平台硬限制约束：
// 单条语句最多 100 个绑定参数、SQL 文本最大 100KB，一次 batch 最多 100 条语句。
const PARAMS_PER_CHUNK = 5;
const MAX_PARAMS_PER_STATEMENT = 100;
const MAX_STATEMENT_BYTES = 90_000;
const MAX_BATCH_STATEMENTS = 100;
const MAX_BATCH_BYTES = 500_000;

const encoder = new TextEncoder();
function bytes(value) {
  return encoder.encode(String(value)).length;
}

function statementSize(statement) {
  let size = bytes(statement.sql);
  for (const param of statement.params) size += bytes(param) + 4;
  return size;
}

// 多行 VALUES 拼 INSERT：参数与体积双重封顶，单条片段超长时也只独占一条语句，不丢内容
export function chunkInsertStatements(docId, chunks) {
  const rows = [];
  const statements = [];
  const flush = () => {
    if (!rows.length) return;
    statements.push({
      sql: `INSERT INTO chunks (id, doc_id, ordinal, content, char_count) VALUES ${rows.map(() => "(?, ?, ?, ?, ?)").join(", ")}`,
      params: rows.flat(),
    });
    rows.length = 0;
  };
  for (const [ordinal, content] of chunks.entries()) {
    const row = [chunkId(docId, ordinal), docId, ordinal, content, content.length];
    const rowBytes = row.reduce((size, value) => size + bytes(value) + 4, 0);
    if (rows.length && (rows.length * PARAMS_PER_CHUNK + PARAMS_PER_CHUNK > MAX_PARAMS_PER_STATEMENT || rowBytes > MAX_STATEMENT_BYTES)) flush();
    rows.push(row);
  }
  flush();
  return statements;
}

// 把语句切成「一次请求一组」，受单次请求的体积与条数上限约束
export function groupStatements(statements) {
  const groups = [];
  let group = [];
  let groupBytes = 0;
  for (const statement of statements) {
    const size = statementSize(statement);
    if (group.length && (groupBytes + size > MAX_BATCH_BYTES || group.length >= MAX_BATCH_STATEMENTS)) {
      groups.push(group);
      group = [];
      groupBytes = 0;
    }
    group.push(statement);
    groupBytes += size;
  }
  if (group.length) groups.push(group);
  return groups;
}

async function runBatch(env, statements) {
  const uuid = await databaseUuid(env);
  let batched = true;
  let reason = "";
  for (const group of groupStatements(statements)) {
    const result = await d1.batch(env, uuid, group);
    if (!result.batched) {
      batched = false;
      reason = result.reason;
    }
  }
  return { batched, reason };
}

export function chunkId(docId, ordinal) {
  return `${docId}-${ordinal}`;
}

export async function saveDocument(env, { docId, title, origin, text, chunks }) {
  return runBatch(env, [
    {
      sql: "INSERT INTO documents (id, title, origin, char_count, chunk_count) VALUES (?, ?, ?, ?, ?)",
      params: [docId, title, origin, text.length, chunks.length],
    },
    ...chunkInsertStatements(docId, chunks),
  ]);
}

export async function deleteDocumentRows(env, docId) {
  return runBatch(env, [
    { sql: "DELETE FROM chunks WHERE doc_id = ?", params: [docId] },
    { sql: "DELETE FROM documents WHERE id = ?", params: [docId] },
  ]);
}

export async function listDocuments(env) {
  return run(env, "SELECT id, title, origin, char_count, chunk_count, created_at FROM documents ORDER BY created_at DESC LIMIT 200");
}

export async function requireDocument(env, docId) {
  const rows = await run(env, "SELECT id, title FROM documents WHERE id = ?", [docId]);
  if (!rows.length) throw new HttpError(404, `未找到文档 ${docId}`);
  return rows[0];
}

export async function getChunkRows(env, ids) {
  if (!ids.length) return new Map();
  const placeholders = ids.map(() => "?").join(", ");
  const rows = await run(
    env,
    `SELECT c.id, c.content, c.ordinal, d.title, d.id AS doc_id FROM chunks c JOIN documents d ON d.id = c.doc_id WHERE c.id IN (${placeholders})`
  , ids);
  return new Map(rows.map((row) => [row.id, row]));
}

export async function listChunkIds(env, docId) {
  const rows = await run(env, "SELECT id FROM chunks WHERE doc_id = ? ORDER BY ordinal", [docId]);
  return rows.map((row) => row.id);
}

// 关键词召回：向量检索容易漏掉专有名词、数字与日期，这里用 LIKE 在整个库里捞一遍
export async function keywordCandidates(env, terms, limit = 24) {
  if (!terms.length) return [];
  const { sql, params } = keywordSql(terms, limit);
  return run(env, sql, params);
}

export async function countAll(env) {
  const rows = await run(env, "SELECT (SELECT count(*) FROM documents) AS docs, (SELECT count(*) FROM chunks) AS chunks");
  return rows[0] ?? { docs: 0, chunks: 0 };
}
