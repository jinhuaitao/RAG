import { fail, HttpError, json, readIngest, readJson, requireAuth, validateTextField } from "./lib/http.js";
import { chunkText, extractText } from "./lib/chunk.js";
import { deleteDocumentRows, getChunkRows, listChunkIds, listDocuments, countAll, requireDocument, saveDocument } from "./lib/store.js";
import { deleteVectors, indexDocument, searchChunkIds } from "./lib/rag.js";
import { generateAnswer } from "./lib/answer.js";

const INT = { min: 1, max: 20 };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    try {
      return await route(request, env, url);
    } catch (error) {
      return fail(error);
    }
  },
};

async function route(request, env, url) {
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method.toUpperCase();

  if (method === "GET" && path === "/api/status") return status(env);
  if (path === "/api/documents") {
    if (method === "GET") return list(env, request);
    if (method === "POST") return create(env, request);
    throw new HttpError(405, "该路径只支持 GET 或 POST");
  }
  const docMatch = path.match(/^\/api\/documents\/([0-9a-f-]{36})$/);
  if (docMatch && method === "DELETE") return remove(env, request, docMatch[1]);
  if (method === "POST" && path === "/api/ask") return ask(env, request);

  throw new HttpError(404, `未知接口 ${method} ${path}`, {
    endpoints: ["GET /api/status", "POST /api/documents", "GET /api/documents", "DELETE /api/documents/:id", "POST /api/ask"],
  });
}

async function status(env) {
  const counts = await countAll(env);
  return json({
    ok: true,
    counts,
    auth_required: Boolean(env.ADMIN_TOKEN),
    config: {
      embedding_model: env.EMBEDDING_MODEL,
      embedding_dimensions: Number(env.EMBEDDING_DIMENSIONS),
      chat_model: env.CHAT_MODEL,
      top_k: Number(env.TOP_K) || 6,
      chunk_max_chars: Number(env.CHUNK_MAX_CHARS) || 600,
    },
  });
}

async function list(env, request) {
  await requireAuth(request, env);
  return json({ documents: await listDocuments(env) });
}

async function create(env, request) {
  await requireAuth(request, env);
  const { title, text, origin } = await readIngest(request, env);
  validateTextField(text, Number(env.MAX_DOC_CHARS) || 200_000);

  const chunks = chunkText(extractText(title, text), {
    maxChars: Number(env.CHUNK_MAX_CHARS) || 600,
    overlap: Number(env.CHUNK_OVERLAP_CHARS) || 120,
  });
  if (!chunks.length) throw new HttpError(400, "切片后没有可用内容，请检查文档是否为空或全为二进制内容");

  const docId = crypto.randomUUID();
  await saveDocument(env, { docId, title, origin, text, chunks });

  let indexed;
  try {
    indexed = await indexDocument(env, docId, chunks);
  } catch (error) {
    await deleteDocumentRows(env, docId).catch(() => {});
    throw error;
  }

  return json({ ok: true, docId, title, chunkCount: chunks.length, embedding: indexed }, 201);
}

async function remove(env, request, docId) {
  await requireAuth(request, env);
  await requireDocument(env, docId);
  const ids = await listChunkIds(env, docId);
  await deleteVectors(env, ids);
  await deleteDocumentRows(env, docId);
  return json({ ok: true, docId, deletedChunks: ids.length });
}

async function ask(env, request) {
  await requireAuth(request, env);
  const body = await readJson(request, 64 * 1024);
  const question = String(body.question ?? "").trim();
  if (!question) throw new HttpError(400, "缺少字段 question");
  if (question.length > 2000) throw new HttpError(413, "问题过长，最多 2000 字符");

  const requested = Number(body.topK);
  const topK = Math.min(INT.max, Math.max(1, Number.isFinite(requested) && requested > 0 ? Math.round(requested) : Number(env.TOP_K) || 6));

  const started = Date.now();
  const hits = await searchChunkIds(env, question, topK);
  const rows = await getChunkRows(env, hits.map((h) => h.id));
  const passages = hits
    .map((hit) => {
      const row = rows.get(hit.id);
      return row ? { docId: row.doc_id, title: row.title, ordinal: row.ordinal, content: row.content, score: hit.score } : null;
    })
    .filter(Boolean);

  const result = await generateAnswer(env, { question, passages });
  return json({
    question,
    answer: result.answer,
    sources: passages.map((p, i) => ({ index: i + 1, docId: p.docId, title: p.title, ordinal: p.ordinal, score: Number(p.score.toFixed(4)), excerpt: p.content.slice(0, 300) })),
    timings: { retrievalMs: Date.now() - started, totalMs: Date.now() - started },
    noContext: result.empty === true,
  });
}
