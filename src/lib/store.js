import { d1 } from "./cfapi.js";
import { HttpError } from "./http.js";

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

export function chunkId(docId, ordinal) {
  return `${docId}-${ordinal}`;
}

export async function saveDocument(env, { docId, title, origin, text, chunks }) {
  await run(env, "INSERT INTO documents (id, title, origin, char_count, chunk_count) VALUES (?, ?, ?, ?, ?)", [
    docId,
    title,
    origin,
    text.length,
    chunks.length,
  ]);
  for (const [ordinal, content] of chunks.entries()) {
    await run(env, "INSERT INTO chunks (id, doc_id, ordinal, content, char_count) VALUES (?, ?, ?, ?, ?)", [
      chunkId(docId, ordinal),
      docId,
      ordinal,
      content,
      content.length,
    ]);
  }
}

export async function deleteDocumentRows(env, docId) {
  await run(env, "DELETE FROM chunks WHERE doc_id = ?", [docId]);
  await run(env, "DELETE FROM documents WHERE id = ?", [docId]);
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

export async function countAll(env) {
  const rows = await run(env, "SELECT (SELECT count(*) FROM documents) AS docs, (SELECT count(*) FROM chunks) AS chunks");
  return rows[0] ?? { docs: 0, chunks: 0 };
}
