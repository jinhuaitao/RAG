// Cloudflare REST API 封装：让 Worker 自己创建并读写 D1 与 Vectorize，
// 从而不需要 wrangler 绑定，也不需要预先手填资源 ID——控制台部署即可跑通。
// 规格取自 wrangler 4.146 内置的 cloudflare SDK（v2 端点 + NDJSON 写入）。
import { HttpError } from "./http.js";

const DEFAULT_BASE = "https://api.cloudflare.com/client/v4";

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
    throw new HttpError(502, `无法访问 Cloudflare API（${url}）：${error.message}`);
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
    const error = new HttpError(response.status >= 500 ? 502 : response.status, `Cloudflare API ${method} ${path} 失败：${detail}`);
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
    const result = await call(env, `/accounts/{account_id}/d1/database/${uuid}/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sql, params }),
    });
    const payload = Array.isArray(result) ? result[0] : result;
    if (payload?.success === false) {
      throw new HttpError(500, `SQL 执行失败：${JSON.stringify(payload?.errors ?? payload)}`);
    }
    return payload?.results ?? [];
  },
};

// ---- Vectorize（v2 端点，写入用 NDJSON）--------------------------------------
export const vectorize = {
  async listIndexes(env) {
    const result = await call(env, "/accounts/{account_id}/vectorize/v2/indexes");
    return Array.isArray(result) ? result : (result?.indexes ?? []);
  },

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
    const body = items.map((item) => JSON.stringify(item)).join("\n");
    return call(env, `/accounts/{account_id}/vectorize/v2/indexes/${encodeURIComponent(name)}/upsert`, {
      method: "POST",
      headers: { "content-type": "application/x-ndjson" },
      body,
    });
  },

  async query(env, name, vector, { topK, returnMetadata = false } = {}) {
    return call(env, `/accounts/{account_id}/vectorize/v2/indexes/${encodeURIComponent(name)}/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ vector, topK, returnMetadata }),
    });
  },

  async deleteByIds(env, name, ids) {
    return call(env, `/accounts/{account_id}/vectorize/v2/indexes/${encodeURIComponent(name)}/delete_by_ids`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ids),
    });
  },
};
