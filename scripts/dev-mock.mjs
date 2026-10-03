// 离线冒烟/预览：起一个假的 Cloudflare REST API（D1 + Vectorize v2 端点）和一个假的 Workers AI，
// Worker 代码走的是真实 REST 路径，所以不登录 Cloudflare 也能端到端验证「初始化 → 入库 → 检索 → 问答 → 删除」。
// 用法：node scripts/dev-mock.mjs [port]
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import worker from "../src/index.js";

const DIMENSIONS = Number(process.env.EMBEDDING_DIMENSIONS || 1024);
const APP_PORT = Number(process.argv[2]) || 8790;
const API_PORT = APP_PORT + 1;
const ACCOUNT_ID = "mock-account-0000";
const API_TOKEN = "mock-token";

// ---- 假的 Cloudflare API ----------------------------------------------------
const databases = new Map(); // uuid -> { name, sqlite }
const indexes = new Map(); // name -> { config, vectors: Map }

function envelope(result, errors = []) {
  return JSON.stringify({ success: errors.length === 0, errors, result, messages: [] });
}

function badRequest(message, code = 400) {
  return { status: 400, body: envelope(null, [{ code, message }]) };
}

async function readBody(req) {
  const parts = [];
  for await (const chunk of req) parts.push(chunk);
  return Buffer.concat(parts).toString("utf8");
}

// 伪嵌入：字符 2-gram 哈希到固定维度，让「词重叠越多、向量越近」，检索结果才有判别力
function fakeEmbedding(text) {
  const vector = new Array(DIMENSIONS).fill(0);
  const clean = String(text).toLowerCase();
  const grams = [];
  for (let i = 0; i < clean.length - 1; i += 1) grams.push(clean.slice(i, i + 2));
  for (const word of clean.split(/[^a-z0-9_\u4e00-\u9fff]+/)) if (word.length > 1) grams.push(word);
  for (const gram of grams) {
    let hash = 2166136261;
    for (let i = 0; i < gram.length; i += 1) hash = ((hash ^ gram.charCodeAt(i)) * 16777619) >>> 0;
    vector[hash % DIMENSIONS] += 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${API_PORT}`);
  const send = (status, body, type = "application/json") => {
    res.writeHead(status, { "content-type": type });
    res.end(body);
  };

  if ((req.headers.authorization || "") !== `Bearer ${API_TOKEN}`) {
    return send(401, envelope(null, [{ code: 10000, message: "Authentication error" }]));
  }

  const path = url.pathname.replace(`/client/v4/accounts/${ACCOUNT_ID}`, "");
  const body = ["POST", "PUT"].includes(req.method) ? await readBody(req) : "";

  // D1：列库 / 建库
  if (path === "/d1/database" && req.method === "GET") {
    return send(200, envelope([...databases].map(([uuid, database]) => ({ uuid, name: database.name }))));
  }
  if (path === "/d1/database" && req.method === "POST") {
    const { name } = JSON.parse(body || "{}");
    if ([...databases.values()].some((database) => database.name === name)) {
      return send(409, envelope(null, [{ code: 7502, message: "A database with that name already exists" }]));
    }
    const uuid = randomUUID();
    databases.set(uuid, { name, sqlite: new DatabaseSync(":memory:") });
    return send(200, envelope({ uuid, name }));
  }

  // D1：执行 SQL。公开 REST 的请求体只有两种合法分支：{sql, params} 与 {batch:[{sql, params}]}。
  // 裸数组是 workerd 内部绑定的格式，真实端点会拒（MOCK_REJECT_BATCH=1 可以演这个退回路径）
  const queryMatch = path.match(/^\/d1\/database\/([0-9a-f-]{36})\/query$/);
  if (queryMatch) {
    const database = databases.get(queryMatch[1]);
    if (!database) return send(404, envelope(null, [{ code: 7001, message: "Database not found" }]));
    const payload = JSON.parse(body || "{}");
    const run = ({ sql, params = [] }) => {
      try {
        return { success: true, meta: { changes: 0 }, results: database.sqlite.prepare(sql).all(...params) };
      } catch (error) {
        // 与真实 D1 一致：失败体是 { success:false, error:"…" }，不是 errors 数组
        return { success: false, error: error.message };
      }
    };
    if (Array.isArray(payload) || (payload.batch && process.env.MOCK_REJECT_BATCH)) {
      return send(400, envelope(null, [{ code: 10000, message: "Invalid input: Expected object, received array" }]));
    }
    if (payload.batch) return send(200, envelope(payload.batch.map(run)));
    // 真实端点即使单条也把 result 包成数组，这里保持一致
    return send(200, envelope([run(payload)]));
  }

  // Vectorize v2：索引列表 / 创建 / 获取
  if (path === "/vectorize/v2/indexes" && req.method === "GET") {
    return send(200, envelope([...indexes].map(([name, index]) => ({ name, config: index.config, created_on: "2026-01-01T00:00:00Z" }))));
  }
  if (path === "/vectorize/v2/indexes" && req.method === "POST") {
    const payload = JSON.parse(body || "{}");
    if (!payload.name || !payload.config?.dimensions || !payload.config?.metric) return send(400, envelope(null, [{ message: "缺少 name 或 config.dimensions/metric" }]));
    indexes.set(payload.name, { config: payload.config, vectors: new Map() });
    return send(200, envelope({ name: payload.name, config: payload.config, created_on: "2026-01-01T00:00:00Z" }));
  }
  const indexMatch = path.match(/^\/vectorize\/v2\/indexes\/([^/]+)(?:\/(upsert|query|delete_by_ids|insert))?$/);
  if (!indexMatch) return send(404, envelope(null, [{ message: `mock 未实现 ${req.method} ${path}` }]));

  const indexName = decodeURIComponent(indexMatch[1]);
  const action = indexMatch[2];
  const index = indexes.get(indexName);
  if (!index && !action) return send(404, envelope(null, [{ message: "Index not found" }]));
  if (!index) return send(404, envelope(null, [{ message: `Index ${indexName} 不存在，请先初始化` }]));

  if (req.method === "GET") return send(200, envelope({ name: indexName, config: index.config }));

  if (action === "upsert") {
    const contentType = req.headers["content-type"] || "";
    if (!contentType.includes("application/x-ndjson")) {
      return send(400, envelope(null, [{ message: `upsert 需要 application/x-ndjson，实际 ${contentType}` }]));
    }
    let count = 0;
    for (const line of body.split("\n").filter(Boolean)) {
      const item = JSON.parse(line);
      if (!item.id || !Array.isArray(item.values)) return badRequest("NDJSON 每行必须含 id 与 values");
      if (item.values.length !== index.config.dimensions) {
        return badRequest(`failed to parse upsert vectors: dimension mismatch ${item.values.length} != ${index.config.dimensions}`);
      }
      index.vectors.set(item.id, item);
      count += 1;
    }
    return send(200, envelope({ mutationId: randomUUID(), upsertCount: count }));
  }

  if (action === "query") {
    let payload;
    try {
      payload = JSON.parse(body || "");
    } catch (error) {
      return badRequest(`Failed to parse the request body as JSON: ${error.message}`);
    }
    const { vector, topK } = payload;
    if (!Array.isArray(vector)) return badRequest("query 需要 vector 数组");
    if (vector.length !== index.config.dimensions) {
      return badRequest(`dimension mismatch ${vector.length} != ${index.config.dimensions}`);
    }
    if (vector.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
      return badRequest("vector 含非数字值");
    }
    const scored = [...index.vectors].map(([id, item]) => {
      let dot = 0;
      for (let i = 0; i < vector.length; i += 1) dot += vector[i] * item.values[i];
      return { id, score: dot, metadata: item.metadata ?? {}, namespace: "" };
    });
    scored.sort((a, b) => b.score - a.score);
    return send(200, envelope({ timestamp: Date.now(), partial: false, matches: scored.slice(0, topK || 10) }));
  }

  if (action === "delete_by_ids") {
    const payload = JSON.parse(body || "null");
    if (Array.isArray(payload)) {
      // 复刻真实服务端：裸数组会被按 Vec<Seq> 解析并报错，只接受 {ids: [...]}
      return badRequest(`Failed to deserialize the JSON body into the target type: [0]: invalid type: string ${JSON.stringify(payload[0])}, expected a sequence`);
    }
    const ids = payload?.ids;
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
      return badRequest("delete_by_ids 需要 {ids: string[]}");
    }
    for (const id of ids) index.vectors.delete(id);
    return send(200, envelope({ mutationId: randomUUID(), deleteCount: ids.length }));
  }

  return send(404, envelope(null, [{ message: `mock 不支持 ${req.method} ${path}` }]));
}

const api = createServer((req, res) => {
  handleApi(req, res).catch((error) => {
    console.error(`mock API 未捕获异常：${error.stack || error.message}`);
    res.writeHead(500, { "content-type": "application/json" });
    res.end(envelope(null, [{ message: `mock 内部错误：${error.message}` }]));
  });
});

// ---- 假的 Workers AI 绑定 ---------------------------------------------------
const AI = {
  async run(model, input) {
    if (input && (Array.isArray(input.text) || typeof input.text === "string")) {
      const texts = Array.isArray(input.text) ? input.text : [input.text];
      return { data: texts.map(fakeEmbedding), model: `${model} (mock)` };
    }
    // 复刻真实账号上遇到过的下线错误（5028），用来验证 Worker 的中文提示分支
    if (/llama-3\.1-8b-instruct(?!-fp8)/.test(model)) {
      throw new Error(`5028: @cf/meta/infire-${model.split("/").pop()} was deprecated on 2026-05-30. See the model catalog for alternatives.`);
    }
    const user = [...(input.messages ?? [])].reverse().find((message) => message.role === "user")?.content ?? "";
    const context = user.match(/【参考资料】([\s\S]*?)【问题】/)?.[1] ?? "";
    const question = user.match(/【问题】\n([\s\S]*)$/)?.[1]?.trim() ?? "";
    if (!context.trim()) return { response: "知识库中没有相关信息。" };
    const numbered = [...context.matchAll(/【(\d+)】《([^》]+)》/g)].map(([, n, title]) => `[${n}]《${title}》`);
    return { response: `（模拟回答，非真实模型输出）关于“${question}”：依据 ${numbered.join("、") || "[1]"}。`, model: "mock" };
  },
};

const env = {
  AI,
  ASSETS: {
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      const file = path === "/" ? "index.html" : path.replace(/^\/+/, "");
      try {
        const content = readFileSync(new URL(`../public/${file}`, import.meta.url));
        const type = file.endsWith(".css") ? "text/css" : file.endsWith(".js") ? "text/javascript" : "text/html";
        return new Response(content, { headers: { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store" } });
      } catch {
        return new Response("Not found", { status: 404 });
      }
    },
  },
  CF_API_BASE: `http://127.0.0.1:${API_PORT}/client/v4`,
  CLOUDFLARE_API_TOKEN: API_TOKEN,
  CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
  DB_NAME: "rag-kb-db",
  INDEX_NAME: "rag-kb-index",
  EMBEDDING_MODEL: "@cf/mock/bge-m3",
  EMBEDDING_DIMENSIONS: String(DIMENSIONS),
  EMBEDDING_METRIC: "cosine",
  CHAT_MODEL: process.env.CHAT_MODEL || "@cf/mock/llama",
  CHAT_MAX_TOKENS: "1500",
  TOP_K: "6",
  CHUNK_MAX_CHARS: "600",
  CHUNK_OVERLAP_CHARS: "120",
  MAX_DOC_CHARS: "200000",
  MAX_CONTEXT_CHARS: "12000",
  ADMIN_TOKEN: process.env.ADMIN_TOKEN || "mock-token",
  // 本机端到端要抓取 127.0.0.1 的示例页，所以只在 mock 里放开内网拦截
  ALLOW_PRIVATE_URLS: "true",
  FETCH_TIMEOUT_MS: "5000",
  FETCH_MAX_BYTES: "800000",
};

api.listen(API_PORT, "127.0.0.1");

const SAMPLE_PAGE = readFileSync(new URL("../fixtures/return-policy.html", import.meta.url));

function serveSample(res, status, headers) {
  res.writeHead(status, headers);
  res.end(SAMPLE_PAGE);
}

createServer(async (req, res) => {
  const path = new URL(req.url, `http://127.0.0.1:${APP_PORT}`).pathname;
  // 供网址抓取端到端使用：一个真实网页 + 一次重定向，都走本机地址
  if (path === "/fixture/page") {
    return serveSample(res, 200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  }
  if (path === "/fixture/redirect") {
    return serveSample(res, 302, { location: `http://127.0.0.1:${APP_PORT}/fixture/page`, "cache-control": "no-store" });
  }
  if (path === "/fixture/plain") {
    return serveSample(res, 200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  }

  const parts = [];
  for await (const chunk of req) parts.push(chunk);
  const request = new Request(`http://127.0.0.1:${APP_PORT}${req.url}`, {
    method: req.method,
    headers: new Headers(req.headers),
    body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(parts),
  });
  const response = await worker.fetch(request, env, {});
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(APP_PORT, "127.0.0.1", () => {
  console.log(`✓ 应用 http://127.0.0.1:${APP_PORT}  ·  假 Cloudflare API http://127.0.0.1:${API_PORT}/client/v4`);
  console.log(`  访问令牌（ADMIN_TOKEN）= ${env.ADMIN_TOKEN}   D1/Vectorize 为内存模拟，重启即清空`);
});
