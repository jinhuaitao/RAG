import { fail, HttpError, json, readIngest, readJson, requireAuth, validateTextField } from "./lib/http.js";
import { chunkText, extractText } from "./lib/chunk.js";
import { cleanText } from "./lib/clean.js";
import { grabUrl } from "./lib/grab.js";
import { countAll, deleteDocumentRows, getChunkRows, keywordCandidates, listChunkIds, listDocuments, requireDocument, saveDocument } from "./lib/store.js";
import { deleteVectors, indexDocument, searchChunkIds } from "./lib/rag.js";
import { extractTerms, keywordTerms, overlapScore, rankCandidates, stripOverlap } from "./lib/rank.js";
import { generateAnswer } from "./lib/answer.js";
import { initialize, provisionStatus } from "./lib/setup.js";

const TOP_K_LIMIT = 20;
const RECALL_POOL_MAX = 24;

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
  // documents 行与全部 chunks 行一次请求写入；写失败时把半截的片段清掉，
  // 否则会留下没有 documents 行的孤儿片段——列表里看不到，也就再也删不掉
  let stored;
  try {
    stored = await saveDocument(env, { docId, title, origin: input.origin, text: cleaned.text, chunks });
  } catch (error) {
    await deleteDocumentRows(env, docId).catch(() => {});
    throw error;
  }

  let indexed;
  try {
    indexed = await indexDocument(env, docId, chunks);
  } catch (error) {
    await deleteDocumentRows(env, docId).catch(() => {});
    throw error;
  }

  return json(
    {
      ok: true,
      docId,
      title,
      origin: input.origin,
      sourceUrl,
      chunkCount: chunks.length,
      cleaned: cleaned.stats,
      embedding: indexed,
      ...(stored.batched ? {} : { d1Sequential: `D1 未接受批量请求体，已退回逐条写入：${stored.reason}` }),
    },
    201
  );
}

async function remove(env, docId) {
  await requireDocument(env, docId);
  const ids = await listChunkIds(env, docId);
  await deleteVectors(env, ids);
  const stored = await deleteDocumentRows(env, docId);
  return json({
    ok: true,
    docId,
    deletedChunks: ids.length,
    ...(stored.batched ? {} : { d1Sequential: `D1 未接受批量请求体，已退回逐条删除：${stored.reason}` }),
  });
}

async function ask(env, request) {
  const body = await readJson(request, 64 * 1024);
  const question = String(body.question ?? "").trim();
  if (!question) throw new HttpError(400, "缺少字段 question");
  if (question.length > 2000) throw new HttpError(413, "问题过长，最多 2000 字符");

  const requested = Number(body.topK);
  const topK = Math.min(TOP_K_LIMIT, Math.max(1, Number.isFinite(requested) && requested > 0 ? Math.round(requested) : Number(env.TOP_K) || 6));

  const started = Date.now();
  const terms = extractTerms(question);
  const coreTerms = keywordTerms(terms);
  const pool = Math.min(RECALL_POOL_MAX, Math.max(topK * 4, 8));
  // 两路召回同时进行：向量负责同义改写，LIKE 关键词负责专有名词、数字与日期，然后在本地重排
  const [vectorHits, keywordHits] = await Promise.all([
    searchChunkIds(env, question, pool),
    keywordCandidates(env, coreTerms, pool),
  ]);

  const candidateIds = [...new Set([...vectorHits.map((hit) => hit.id), ...keywordHits.map((hit) => hit.id)])];
  const rows = await getChunkRows(env, candidateIds);
  const ranked = stripOverlap(rankCandidates({ vectorHits, keywordHits, rows, terms, coreTerms, limit: topK }));

  const timings = { totalMs: Date.now() - started, candidates: candidateIds.length };
  if (!ranked.length) {
    // 与其让模型硬答，不如直接说明没命中，并告诉用户怎么问才命中
    const best = Math.max(0, ...[...rows.values()].map((row) => overlapScore(terms, coreTerms, row.content)));
    return json({
      question,
      answer: rows.size
        ? `知识库中没有足够相关的资料来回答这个问题：检索到 ${rows.size} 个候选片段，最高关键词命中 ${Math.round(best * 100)}%，语义相似度也不够。\n可以试试：① 换成文档里出现过的说法；② 在提问里带上具体名词或数字；③ 确认相关资料是否已入库。`
        : "知识库里没有任何片段与这个问题相关。请先在「知识库管理」里上传、粘贴文档或填入网址，再换一种提问角度。",
      sources: [],
      timings,
      noContext: true,
      terms: terms.map((entry) => entry.term),
    });
  }

  const result = await generateAnswer(env, { question, passages: ranked, terms });
  return json({
    question,
    answer: result.answer,
    sources: result.used,
    timings,
    noContext: false,
    terms: terms.map((entry) => entry.term),
  });
}
