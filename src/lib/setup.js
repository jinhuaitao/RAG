import { d1, hasCredentials, vectorize } from "./cfapi.js";
import { HttpError } from "./http.js";
import { SCHEMA_STATEMENTS } from "./schema.js";
import { databaseUuid, resetDatabaseCache } from "./store.js";

// 幂等：D1 库、两张表、Vectorize 索引，缺哪个建哪个
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

  const existing = await vectorize.getIndex(env, env.INDEX_NAME);
  if (existing) {
    const dimensions = existing?.config?.dimensions ?? existing?.dimensions;
    if (dimensions && Number(dimensions) !== Number(env.EMBEDDING_DIMENSIONS)) {
      throw new HttpError(409, `索引 ${env.INDEX_NAME} 已存在但维度是 ${dimensions}，与配置的 ${env.EMBEDDING_DIMENSIONS} 不符`, {
        hint: "先在控制台删除该索引，或把 EMBEDDING_DIMENSIONS 改成实际维度，再重新初始化",
      });
    }
    steps.push({ step: "vectorize", action: "skip", detail: `${env.INDEX_NAME} 已存在` });
  } else {
    await vectorize.createIndex(env, {
      name: env.INDEX_NAME,
      dimensions: Number(env.EMBEDDING_DIMENSIONS),
      metric: env.EMBEDDING_METRIC || "cosine",
      description: "RAG 知识库切片向量",
    });
    steps.push({ step: "vectorize", action: "create", detail: `${env.INDEX_NAME} ${env.EMBEDDING_DIMENSIONS}d/${env.EMBEDDING_METRIC || "cosine"}` });
  }

  return { ok: true, database_id: uuid, steps };
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
    if (index) status.index = { name: env.INDEX_NAME, dimensions: index?.config?.dimensions ?? index?.dimensions ?? Number(env.EMBEDDING_DIMENSIONS) };
  } catch (error) {
    status.error = `Vectorize 检查失败：${error.message}`;
  }
  return status;
}
