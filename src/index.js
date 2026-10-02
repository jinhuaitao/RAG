import { fail, HttpError, json, readIngest, readJson, requireAuth, validateTextField } from "./lib/http.js";
import { chunkText, extractText } from "./lib/chunk.js";
import { cleanText } from "./lib/clean.js";
import { grabUrl } from "./lib/grab.js";
import { countAll, deleteDocumentRows, getChunkRows, listChunkIds, listDocuments, requireDocument, saveDocument } from "./lib/store.js";
import { deleteVectors, indexDocument, searchChunkIds } from "./lib/rag.js";
import { generateAnswer } from "./lib/answer.js";
import { initialize, provisionStatus } from "./lib/setup.js";

const TOP_K_LIMIT = 20;

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

  // Worker 持有可创建/删除资源的 API Token，因此除了状态查询，一律要求访问令牌
  await requireAuth(request, env);

  if (path === "/api/documents") {
    if (method === "GET") return list(env);
    if (method === "POST") return create(env, request);
    throw new HttpError(405, "该路径只支持 GET 或 POST");
  }
  const docMatch = path.match(/^\/api\/documents\/([0-9a-f-]{36})$/);
  if (docMatch && method === "DELETE") return remove(env, docMatch[1]);
  if (method === "POST" && path === "/api/ask") return ask(env, request);
  if (method === "POST" && path === "/api/admin/setup") return json(await initialize(env));

  throw new HttpError(404, `未知接口 ${method} ${path}`, {
    endpoints: ["GET /api/status", "POST /api/admin/setup", "POST /api/documents", "GET /api/documents", "DELETE /api/documents/:id", "POST /api/ask"],
  });
}

async function status(env) {
  const provision = await provisionStatus(env);
  return json({
    ok: true,
    auth_required: Boolean(env.ADMIN_TOKEN),
    provisioned: Boolean(provision.credentials && provision.database && provision.tables && provision.index),
    provision,
    config: {
      embedding_model: env.EMBEDDING_MODEL,
      embedding_dimensions: Number(env.EMBEDDING_DIMENSIONS),
      chat_model: env.CHAT_MODEL,
      index_name: env.INDEX_NAME,
      database_name: env.DB_NAME,
      top_k: Number(env.TOP_K) || 6,
      chunk_max_chars: Number(env.CHUNK_MAX_CHARS) || 600,
    },
  });
}

async function list(env) {
  return json({ documents: await listDocuments(env), counts: await countAll(env) });
}

async function create(env, request) {
  const input = await readIngest(request, env);
  let { title, text } = input;
  let sourceUrl = "";
  if (input.origin === "url") {
    const grabbed = await grabUrl(env, input.url);
    text = grabbed.text;
    sourceUrl = grabbed.finalUrl;
    title = title || grabbed.title || new URL(grabbed.finalUrl).hostname;
  }
  validateTextField(text, Number(env.MAX_DOC_CHARS) || 200_000);

  // 入库前先做规则清洗：去掉网页/Word/PDF 带来的噪声、合并被硬断开的行，
  // 并把所属章节路径注入每个片段。清洗后的文本就是库里保存的文本。
  const cleaned = cleanText(extractText(title, text));
  if (!cleaned.text) {
    throw new HttpError(400, "清洗后没有留下有效正文", {
      hint: "原文可能只包含导航、页眉页脚或装饰符号，请只保留正文章节后重试",
    });
  }

  const chunks = chunkText(cleaned.text, {
    maxChars: Number(env.CHUNK_MAX_CHARS) || 600,
    overlap: Number(env.CHUNK_OVERLAP_CHARS) || 120,
  });
  if (!chunks.length) throw new HttpError(400, "切片后没有可用内容，请检查文档是否为空或全为二进制内容");

  const docId = crypto.randomUUID();
  await saveDocument(env, { docId, title, origin: input.origin, text: cleaned.text, chunks });

  let indexed;
  try {
    indexed = await indexDocument(env, docId, chunks);
  } catch (error) {
    await deleteDocumentRows(env, docId).catch(() => {});
    throw error;
  }

  return json({ ok: true, docId, title, origin: input.origin, sourceUrl, chunkCount: chunks.length, cleaned: cleaned.stats, embedding: indexed }, 201);
}

async function remove(env, docId) {
  await requireDocument(env, docId);
  const ids = await listChunkIds(env, docId);
  await deleteVectors(env, ids);
  await deleteDocumentRows(env, docId);
  return json({ ok: true, docId, deletedChunks: ids.length });
}

async function ask(env, request) {
  const body = await readJson(request, 64 * 1024);
  const question = String(body.question ?? "").trim();
  if (!question) throw new HttpError(400, "缺少字段 question");
  if (question.length > 2000) throw new HttpError(413, "问题过长，最多 2000 字符");

  const requested = Number(body.topK);
  const topK = Math.min(TOP_K_LIMIT, Math.max(1, Number.isFinite(requested) && requested > 0 ? Math.round(requested) : Number(env.TOP_K) || 6));

  const started = Date.now();
  const hits = await searchChunkIds(env, question, topK);
  const rows = await getChunkRows(env, hits.map((hit) => hit.id));
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
    sources: passages.map((passage, index) => ({
      index: index + 1,
      docId: passage.docId,
      title: passage.title,
      ordinal: passage.ordinal,
      score: Number(passage.score.toFixed(4)),
      excerpt: passage.content.slice(0, 300),
    })),
    timings: { totalMs: Date.now() - started },
    noContext: result.empty === true,
  });
}
