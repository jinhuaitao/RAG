import { d1, hasCredentials, vectorize } from "./cfapi.js";
import { HttpError } from "./http.js";
import { SCHEMA_STATEMENTS } from "./schema.js";
import { countChunks, databaseUuid, listChunkPage, resetDatabaseCache } from "./store.js";
import { probeDimensions, reembedChunks } from "./rag.js";

// 一次重建处理多少片段：150 个 = 10 次嵌入请求 + 3 次写入 + 1 次查库，
// 免费版每次调用 50 个子请求的额度够用，超出的部分由前端分批接着做
const REBUILD_PAGE = 150;

function indexSpec(env) {
  return {
    name: env.INDEX_NAME,
    dimensions: Number(env.EMBEDDING_DIMENSIONS),
    metric: env.EMBEDDING_METRIC || "cosine",
    description: "RAG 知识库切片向量",
  };
}

// 按配置重建索引：旧向量对新的嵌入模型没有意义，正文都在 D1 里，重建后重新嵌入即可
async function recreateIndex(env) {
  await vectorize.deleteIndex(env, env.INDEX_NAME);
  await vectorize.createIndex(env, indexSpec(env));
}

async function reembedPage(env, offset) {
  const total = await countChunks(env);
  if (!total) return { total: 0, processed: 0, offset: 0, remaining: 0 };
  const rows = await listChunkPage(env, offset, REBUILD_PAGE);
  if (!rows.length) return { total, processed: 0, offset, remaining: 0 };
  await reembedChunks(env, rows);
  const next = offset + rows.length;
  return { total, processed: rows.length, offset: next, remaining: Math.max(0, total - next) };
}

// 幂等：D1 库、两张表、Vectorize 索引，缺哪个建哪个；
// 索引维度与配置不符时按新维度重建，并把库里的正文重新嵌入
export async function initialize(env) {
  if (!hasCredentials(env)) {
    throw new HttpError(503, "无法初始化：Worker 还缺少 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID", {
      hint: "在 Workers 控制台 Settings → Variables and Secrets 添加这两个 Secret 后再点按钮",
    });
  }
  const steps = [];

  const databases = await d1.listDatabases(env);
  if (databases.some((database) => database.name === env.DB_NAME)) {
    steps.push({ step: "d1", action: "skip", detail: `${env.DB_NAME} 已存在` });
  } else {
    const created = await d1.createDatabase(env, env.DB_NAME);
    steps.push({ step: "d1", action: "create", detail: created?.uuid ?? "" });
  }
  resetDatabaseCache();
  const uuid = await databaseUuid(env);

  // 建表语句全部幂等，合成一次请求：逐条 query 会白占好几个子请求额度
  await d1.batch(env, uuid, SCHEMA_STATEMENTS.map((sql) => ({ sql, params: [] })));
  steps.push({ step: "tables", action: "ensure", detail: "documents / chunks" });

  const expected = Number(env.EMBEDDING_DIMENSIONS);
  const existing = await vectorize.getIndex(env, env.INDEX_NAME);
  let reembed = null;
  if (!existing) {
    await vectorize.createIndex(env, indexSpec(env));
    steps.push({ step: "vectorize", action: "create", detail: `${env.INDEX_NAME} ${expected}d/${env.EMBEDDING_METRIC || "cosine"}` });
  } else {
    const dimensions = Number(existing?.config?.dimensions ?? existing?.dimensions ?? 0);
    if (dimensions && dimensions !== expected) {
      // 先探一次新模型的维度：模型与配置不符要在删索引之前就拦下来
      await probeDimensions(env);
      await recreateIndex(env);
      steps.push({ step: "vectorize", action: "rebuild", detail: `${dimensions} 维 → ${expected} 维` });
      reembed = await reembedPage(env, 0);
    } else {
      steps.push({ step: "vectorize", action: "skip", detail: `${env.INDEX_NAME} 已存在` });
    }
  }

  return { ok: true, database_id: uuid, steps, reembed };
}

// 重建后的续跑：一次 Worker 调用做不完所有片段，前端拿着 offset 一批批接着做
export async function continueReembed(env, offset) {
  const existing = await vectorize.getIndex(env, env.INDEX_NAME);
  if (!existing) {
    throw new HttpError(409, `向量索引 ${env.INDEX_NAME} 不存在，请先点「初始化资源」`, {
      hint: "索引被删掉了，点「初始化资源」会重新建好并重新嵌入库里的正文",
    });
  }
  const expected = Number(env.EMBEDDING_DIMENSIONS);
  const dimensions = Number(existing?.config?.dimensions ?? existing?.dimensions ?? 0);
  if (dimensions && dimensions !== expected) {
    throw new HttpError(409, `索引 ${env.INDEX_NAME} 是 ${dimensions} 维，与配置的 ${expected} 维不符`, {
      hint: "点「初始化资源」按新维度重建索引，并自动重新嵌入库里的正文",
    });
  }
  return reembedPage(env, Math.max(0, Number(offset) || 0));
}

export async function provisionStatus(env) {
  const status = {
    credentials: hasCredentials(env),
    database: null,
    tables: false,
    index: null,
    error: null,
  };
  if (!status.credentials) return status;

  try {
    const databases = await d1.listDatabases(env);
    const found = databases.find((database) => database.name === env.DB_NAME);
    if (!found) return status;
    status.database = { name: found.name, uuid: found.uuid };
    const rows = await d1.query(env, found.uuid, "SELECT count(*) AS docs FROM documents");
    status.tables = Array.isArray(rows) && rows.length > 0;
  } catch (error) {
    status.error = `D1 检查失败：${error.message}`;
    return status;
  }

  try {
    const index = await vectorize.getIndex(env, env.INDEX_NAME);
    if (index) {
      const dimensions = Number(index?.config?.dimensions ?? index?.dimensions ?? 0);
      const expected = Number(env.EMBEDDING_DIMENSIONS);
      status.index = {
        name: env.INDEX_NAME,
        dimensions,
        expected_dimensions: expected,
        mismatch: Boolean(dimensions && dimensions !== expected),
      };
    }
  } catch (error) {
    status.error = `Vectorize 检查失败：${error.message}`;
  }
  return status;
}
