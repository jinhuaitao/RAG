// Cloudflare REST API 封装：让 Worker 自己创建并读写 D1 与 Vectorize，
// 从而不需要 wrangler 绑定，也不需要预先手填资源 ID——控制台部署即可跑通。
// 规格取自 wrangler 4.146 内置的 cloudflare SDK（v2 端点 + NDJSON 写入）。
import { HttpError } from "./http.js";

const DEFAULT_BASE = "https://api.cloudflare.com/client/v4";

// 1024 维 f32 向量按完整精度序列化约 19KB/条，实测 Vectorize 的 query 端点会在解析到请求体
// 末尾时报「Failed to parse the request body as JSON」——即服务端收到的字节数比 Worker 发出的少。
// 压到 6 位小数：cosine 检索精度不受影响（索引本身按 f32 存），体积减半，且可选字段不再排在尾部。
const VECTOR_DECIMALS = 6;

export function encodeVector(values) {
  const list = Array.isArray(values) ? values : Array.from(values ?? []);
  if (!list.length) throw new HttpError(502, "嵌入模型返回了空向量，无法写入或检索");
  const out = new Array(list.length);
  for (let i = 0; i < list.length; i += 1) {
    const value = Number(list[i]);
    if (!Number.isFinite(value)) throw new HttpError(502, `嵌入向量第 ${i} 维不是有限数字（${list[i]}），请更换 EMBEDDING_MODEL`);
    out[i] = Number(value.toFixed(VECTOR_DECIMALS));
  }
  return out;
}

export function credentials(env) {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID || env.ACCOUNT_ID;
  const token = env.CLOUDFLARE_API_TOKEN;
  if (!token || !accountId) {
    throw new HttpError(503, "缺少 Cloudflare API 凭据，Worker 无法访问 D1 / Vectorize", {
      hint: [
        "在 Workers 控制台 Settings → Variables and Secrets 里添加两个 Secret：CLOUDFLARE_API_TOKEN、CLOUDFLARE_ACCOUNT_ID",
        "Token 权限需要：Workers Scripts Edit、Workers D1 Edit、Workers Vector Store Edit、Workers AI Read & Edit",
      ],
    });
  }
  return { accountId, token, base: String(env.CF_API_BASE || DEFAULT_BASE).replace(/\/+$/, "") };
}

export function hasCredentials(env) {
  return Boolean((env.CLOUDFLARE_ACCOUNT_ID || env.ACCOUNT_ID) && env.CLOUDFLARE_API_TOKEN);
}

async function call(env, path, { method = "GET", body, headers = {} } = {}) {
  const { accountId, token, base } = credentials(env);
  const url = `${base}${path.replace("{account_id}", accountId)}`;

  let response;
  try {
    response = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${token}`, ...headers },
      body: body === undefined ? undefined : body,
    });
  } catch (error) {
    const reason = String(error?.message ?? error);
    // Worker 每次调用能发的子请求是硬额度（免费版 50、付费版 1000），撞上了要能看出该做什么
    if (/too many subrequests/i.test(reason)) {
      throw new HttpError(503, `单个 Worker 调用的子请求数已达上限，请求停在 ${new URL(url).pathname}：${reason}`, {
        hint: [
          "免费版每个请求 50 个子请求，付费版 1000：Workers 控制台 → 账号订阅到 Paid 即可解除，不用改代码",
          "不想升级就把这篇长文档拆成几次入库，或把 CHUNK_MAX_CHARS 调大（如 600→1200）减少片段数",
          "每个片段要向嵌入模型发一次批量请求、向 D1/Vectorize 各写一次，片段数直接决定子请求总数",
        ],
      });
    }
    throw new HttpError(502, `无法访问 Cloudflare API（${url}）：${reason}`);
  }

  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    throw new HttpError(502, `Cloudflare API 返回非 JSON：HTTP ${response.status} ${text.slice(0, 200)}`);
  }

  if (!response.ok || payload?.success === false) {
    const first = payload?.errors?.[0];
    const detail = first?.message || text.slice(0, 300) || response.statusText;
    const sent = body === undefined ? 0 : new TextEncoder().encode(String(body)).length;
    const size = sent ? `（请求体 ${sent} 字节）` : "";
    const error = new HttpError(response.status >= 500 ? 502 : response.status, `Cloudflare API ${method} ${path} 失败：${detail}${size}`);
    error.apiCode = first?.code;
    throw error;
  }
  return payload?.result;
}

// ---- D1 ---------------------------------------------------------------------
export const d1 = {
  async listDatabases(env) {
    const result = await call(env, "/accounts/{account_id}/d1/database?per_page=1000");
    return Array.isArray(result) ? result : (result?.results ?? []);
  },

  async createDatabase(env, name) {
    return call(env, "/accounts/{account_id}/d1/database", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
  },

  async query(env, uuid, sql, params = []) {
    const result = await d1Post(env, uuid, { sql, params });
    const payload = Array.isArray(result) ? result[0] : result;
    checkStatement(payload, sql);
    return payload?.results ?? [];
  },

  // 多条语句放进一次请求：D1 的 /query 认数组请求体，服务端按一个隐式事务顺序执行。
  // 逐条 query() 会把「一次入库」变成「N 个子请求」，免费版 50 个的额度撑不住一篇网页。
  async batch(env, uuid, statements) {
    const result = await d1Post(env, uuid, statements);
    const payloads = Array.isArray(result) ? result : [result];
    if (payloads.length !== statements.length) {
      throw new HttpError(502, `D1 批量写入返回了 ${payloads.length} 条结果，但发出了 ${statements.length} 条语句，无法确认哪些已写入`, {
        hint: "这批语句在一个事务里执行，失败时通常全部回滚；请到 D1 控制台核对 documents/chunks 表后重新入库",
      });
    }
    payloads.forEach((payload, index) => {
      checkStatement(payload, index === 0 ? statements[0].sql : `第 ${index + 1}/${statements.length} 条语句：${statements[index].sql.slice(0, 80)}`);
    });
    return payloads.map((payload) => payload?.results ?? []);
  },
};

async function d1Post(env, uuid, payload) {
  return call(env, `/accounts/{account_id}/d1/database/${uuid}/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function checkStatement(payload, sql = "") {
  if (payload?.success === false) {
    throw new HttpError(500, `SQL 执行失败：${JSON.stringify(payload?.errors ?? payload)}${sql ? `\n失败位置：${sql}` : ""}`);
  }
}

// ---- Vectorize（v2 端点，写入用 NDJSON）--------------------------------------
export const vectorize = {
  async createIndex(env, { name, dimensions, metric, description }) {
    return call(env, "/accounts/{account_id}/vectorize/v2/indexes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, description, config: { dimensions, metric } }),
    });
  },

  async getIndex(env, name) {
    try {
      return await call(env, `/accounts/{account_id}/vectorize/v2/indexes/${encodeURIComponent(name)}`, { method: "GET" });
    } catch (error) {
      if (error.status === 404 || /not found/i.test(String(error.message))) return null;
      throw error;
    }
  },

  async upsert(env, name, items) {
    const body = items
      .map((item) => JSON.stringify({ ...item, values: encodeVector(item.values) }))
      .join("\n");
    return call(env, `/accounts/{account_id}/vectorize/v2/indexes/${encodeURIComponent(name)}/upsert`, {
      method: "POST",
      headers: { "content-type": "application/x-ndjson" },
      body,
    });
  },

  async query(env, name, vector, { topK, returnMetadata = false } = {}) {
    // topK 排在前面：向量数组占绝大部分体积，可选字段一律不放在末尾
    const payload = { topK, vector: encodeVector(vector) };
    if (returnMetadata) payload.returnMetadata = true;
    return call(env, `/accounts/{account_id}/vectorize/v2/indexes/${encodeURIComponent(name)}/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  },

  async deleteByIds(env, name, ids) {
    // 真实服务要求 {ids:[...]}（workerd 的官方绑定就是这么发的）；裸数组会被拒：
    // "invalid type: string ..., expected a sequence"。wrangler 里仍是裸数组，属于滞后于服务端。
    return call(env, `/accounts/{account_id}/vectorize/v2/indexes/${encodeURIComponent(name)}/delete_by_ids`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids }),
    });
  },
};
