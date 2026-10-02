import { HttpError } from "./http.js";

export async function saveDocument(env, { docId, title, origin, text, chunks }) {
  const stmts = [
    env.DB.prepare(
      "INSERT INTO documents (id, title, origin, char_count, chunk_count) VALUES (?1, ?2, ?3, ?4, ?5)"
    ).bind(docId, title, origin, text.length, chunks.length),
  ];
  chunks.forEach((content, ordinal) => {
    stmts.push(
      env.DB.prepare("INSERT INTO chunks (id, doc_id, ordinal, content, char_count) VALUES (?1, ?2, ?3, ?4, ?5)").bind(
        chunkId(docId, ordinal),
        docId,
        ordinal,
        content,
        content.length
      )
    );
  });
  await env.DB.batch(stmts);
}

export function chunkId(docId, ordinal) {
  return `${docId}-${ordinal}`;
}

export async function deleteDocumentRows(env, docId) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM chunks WHERE doc_id = ?1").bind(docId),
    env.DB.prepare("DELETE FROM documents WHERE id = ?1").bind(docId),
  ]);
}

export async function listDocuments(env) {
  const { results } = await env.DB.prepare(
    "SELECT id, title, origin, char_count, chunk_count, created_at FROM documents ORDER BY created_at DESC LIMIT 200"
  ).all();
  return results ?? [];
}

export async function requireDocument(env, docId) {
  const { results } = await env.DB.prepare("SELECT id, title FROM documents WHERE id = ?1").bind(docId).all();
  const doc = results?.[0];
  if (!doc) throw new HttpError(404, `未找到文档 ${docId}`);
  return doc;
}

export async function getChunkRows(env, ids) {
  if (!ids.length) return new Map();
  const placeholders = ids.map((_, i) => `?${i + 1}`).join(", ");
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.content, c.ordinal, d.title, d.id AS doc_id FROM chunks c JOIN documents d ON d.id = c.doc_id WHERE c.id IN (${placeholders})`
  )
    .bind(...ids)
    .all();
  const byId = new Map();
  for (const row of results ?? []) byId.set(row.id, row);
  return byId;
}

export async function listChunkIds(env, docId) {
  const { results } = await env.DB.prepare("SELECT id FROM chunks WHERE doc_id = ?1 ORDER BY ordinal").bind(docId).all();
  return (results ?? []).map((row) => row.id);
}

export async function countAll(env) {
  const { results } = await env.DB.prepare("SELECT (SELECT count(*) FROM documents) AS docs, (SELECT count(*) FROM chunks) AS chunks").all();
  return results?.[0] ?? { docs: 0, chunks: 0 };
}
