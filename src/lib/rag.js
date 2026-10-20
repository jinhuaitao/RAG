import { HttpError } from "./http.js";
import { vectorize } from "./cfapi.js";
import { chunkId } from "./store.js";
import { embeddings, expectedDimensions } from "./llm.js";

const EMBED_BATCH = 16;
// Vectorize 单次写入上限 1000 条，但请求体本身也要留余量：1024 维一条约 11KB，50 条 ≈ 550KB
const UPSERT_BATCH = 50;

export async function embed(env, texts) {
  const vectors = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH);
    const data = await embeddings(env, batch);
    for (const vector of data) assertDimensions(env, vector);
    vectors.push(...data);
  }
  return vectors;
}

function assertDimensions(env, vector) {
  const expected = expectedDimensions(env);
  if (!Array.isArray(vector)) throw new HttpError(502, `嵌入模型 ${env.EMBEDDING_MODEL} 没有返回向量数组`);
  if (expected && vector.length !== expected) {
    throw new HttpError(
      500,
      `向量维度不匹配：模型 ${env.EMBEDDING_MODEL} 输出 ${vector.length} 维，但向量索引按 ${expected} 维建`,
      {
        hint: [
          `1) 换一个输出 ${expected} 维的嵌入模型`,
          "2) 已知模型的维度是按模型名自动算的；只有平台自研模型才要手动填 EMBEDDING_DIMENSIONS",
          "3) 改完点「初始化资源」—— 索引维度不符时它会按新维度重建并自动重新嵌入",
        ],
      }
    );
  }
}

async function upsertItems(env, items) {
  const mutations = [];
  for (let i = 0; i < items.length; i += UPSERT_BATCH) {
    const result = await vectorize.upsert(env, env.INDEX_NAME, items.slice(i, i + UPSERT_BATCH));
    if (result?.error) throw new HttpError(502, `向量写入失败：${result.error}`);
    if (result?.mutationId) mutations.push(result.mutationId);
  }
  return mutations;
}

// 删索引前先探一次新模型的维度：模型与配置不符时要在删之前就拦下来
export async function probeDimensions(env) {
  const [vector] = await embed(env, ["维度探测"]);
  return vector.length;
}

export async function indexDocument(env, docId, chunks) {
  const vectors = await embed(env, chunks);
  const items = chunks.map((values, ordinal) => ({
    id: chunkId(docId, ordinal),
    values: vectors[ordinal],
    metadata: { docId, ordinal },
  }));
  const mutations = await upsertItems(env, items);
  // Vectorize 写入是异步排队的，mutation 生效前检索可能查不到刚入库的片段
  return { count: items.length, model: env.EMBEDDING_MODEL, dimensions: vectors[0]?.length ?? 0, mutations };
}

// 重建索引后把 D1 里的正文重新嵌入：向量无法迁移，但原文都还在库里，文档不用重新上传
export async function reembedChunks(env, rows) {
  if (!rows.length) return { count: 0, model: env.EMBEDDING_MODEL, dimensions: expectedDimensions(env), mutations: [] };
  const vectors = await embed(env, rows.map((row) => row.content));
  const items = rows.map((row, index) => ({
    id: row.id,
    values: vectors[index],
    metadata: { docId: row.doc_id, ordinal: row.ordinal },
  }));
  const mutations = await upsertItems(env, items);
  return { count: items.length, model: env.EMBEDDING_MODEL, dimensions: vectors[0]?.length ?? 0, mutations };
}

export async function deleteVectors(env, ids) {
  for (let i = 0; i < ids.length; i += UPSERT_BATCH) {
    await vectorize.deleteByIds(env, env.INDEX_NAME, ids.slice(i, i + UPSERT_BATCH));
  }
}

export async function searchChunkIds(env, question, topK) {
  const [queryVector] = await embed(env, [question]);
  const result = await vectorize.query(env, env.INDEX_NAME, queryVector, { topK });
  const matches = result?.matches ?? result?.result?.matches ?? [];
  return matches.filter((match) => match?.id && match?.score > 0).map((match) => ({ id: match.id, score: match.score }));
}
