import { HttpError } from "./http.js";
import { chunkId } from "./store.js";

const EMBED_BATCH = 16;
const UPSERT_BATCH = 50;

export async function embed(env, texts) {
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
      `向量维度不匹配：模型 ${env.EMBEDDING_MODEL} 输出 ${vector.length} 维，配置与 Vectorize 索引是 ${expected} 维`,
      {
        hint: [
          `1) 用实际维度新建索引：npx wrangler vectorize create rag-kb-index-${vector.length}d --dimensions=${vector.length} --metric=cosine --binding=VECTORIZE --update-config`,
          `2) 把 wrangler.jsonc 里的 EMBEDDING_DIMENSIONS 改成 ${vector.length}`,
          "3) 换模型或改维度后需要重新上传文档入库",
        ],
      }
    );
  }
}

export async function upsertVectors(env, items) {
  for (let i = 0; i < items.length; i += UPSERT_BATCH) {
    const result = await env.VECTORIZE.upsert(items.slice(i, i + UPSERT_BATCH));
    if (result?.error) throw new HttpError(502, `向量写入失败：${result.error}`);
  }
}

export async function indexDocument(env, docId, chunks) {
  const vectors = await embed(env, chunks);
  const items = vectors.map((values, ordinal) => ({
    id: chunkId(docId, ordinal),
    values,
    metadata: { docId, ordinal },
  }));
  await upsertVectors(env, items);
  return { count: items.length, model: env.EMBEDDING_MODEL, dimensions: vectors[0]?.length ?? 0 };
}

export async function deleteVectors(env, ids) {
  for (let i = 0; i < ids.length; i += UPSERT_BATCH) {
    await env.VECTORIZE.deleteByIds(ids.slice(i, i + UPSERT_BATCH));
  }
}

export async function searchChunkIds(env, question, topK) {
  const [queryVector] = await embed(env, [question]);
  const response = await env.VECTORIZE.query(queryVector, { topK, returnMetadata: true });
  const matches = response?.matches ?? response?.result?.matches ?? [];
  return matches.filter((m) => m?.id && m?.score > 0).map((m) => ({ id: m.id, score: m.score }));
}
