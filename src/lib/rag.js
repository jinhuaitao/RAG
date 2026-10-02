import { HttpError } from "./http.js";
import { vectorize } from "./cfapi.js";
import { chunkId } from "./store.js";

const EMBED_BATCH = 16;
// Vectorize 单次写入上限 1000 条，留足余量避免整批失败
const UPSERT_BATCH = 200;

export async function embed(env, texts) {
  if (!env.AI) {
    throw new HttpError(503, "Worker 没有 AI 绑定", { hint: "检查 wrangler.jsonc 是否保留 ai = { binding: \"AI\" }，并重新部署" });
  }
  const vectors = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH);
    const response = await env.AI.run(env.EMBEDDING_MODEL, { text: batch });
    const data = response?.data ?? response?.result?.data;
    if (!Array.isArray(data) || data.length !== batch.length) {
      throw new HttpError(502, `嵌入模型 ${env.EMBEDDING_MODEL} 返回异常：期望 ${batch.length} 条向量，实际 ${Array.isArray(data) ? data.length : "无"}`);
    }
    for (const vector of data) assertDimensions(env, vector);
    vectors.push(...data);
  }
  return vectors;
}

function assertDimensions(env, vector) {
  const expected = Number(env.EMBEDDING_DIMENSIONS);
  if (!Array.isArray(vector)) throw new HttpError(502, `嵌入模型 ${env.EMBEDDING_MODEL} 没有返回向量数组`);
  if (expected && vector.length !== expected) {
    throw new HttpError(
      500,
      `向量维度不匹配：模型 ${env.EMBEDDING_MODEL} 输出 ${vector.length} 维，但配置与向量索引是 ${expected} 维`,
      {
        hint: [
          `1) 把 wrangler.jsonc 里的 EMBEDDING_DIMENSIONS 改成 ${vector.length}`,
          `2) 换维度需要重建索引：控制台删除 ${env.INDEX_NAME} 后点“初始化资源”`,
          "3) 之后把文档删掉重新入库（向量无法迁移）",
        ],
      }
    );
  }
}

export async function indexDocument(env, docId, chunks) {
  const vectors = await embed(env, chunks);
  const items = chunks.map((values, ordinal) => ({
    id: chunkId(docId, ordinal),
    values: vectors[ordinal],
    metadata: { docId, ordinal },
  }));
  const mutations = [];
  for (let i = 0; i < items.length; i += UPSERT_BATCH) {
    const result = await vectorize.upsert(env, env.INDEX_NAME, items.slice(i, i + UPSERT_BATCH));
    if (result?.error) throw new HttpError(502, `向量写入失败：${result.error}`);
    if (result?.mutationId) mutations.push(result.mutationId);
  }
  // Vectorize 写入是异步排队的，mutation 生效前检索可能查不到刚入库的片段
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
