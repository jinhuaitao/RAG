// 离线冒烟/预览：用 node:sqlite 模拟 D1、内存向量库模拟 Vectorize、词袋假嵌入模拟 Workers AI，
// 这样不登录 Cloudflare 也能跑通「入库 → 检索 → 问答 → 删除」全链路和前端页面。
// 用法：node scripts/dev-mock.mjs [port]
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/index.js";

const DIMENSIONS = Number(process.env.EMBEDDING_DIMENSIONS || 1024);

// ---- D1 替身 ----------------------------------------------------------------
const sqlite = new DatabaseSync(":memory:");
sqlite.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));

function normalizeSql(sql) {
  return sql.replace(/\?(\d+)/g, (_, n) => `?${n}`);
}

function prepare(sql) {
  let bound = [];
  const stmt = {
    bind(...values) {
      bound = values;
      return stmt;
    },
    all() {
      return { results: stmt.stmt.all(...bound), success: true, meta: {} };
    },
    raw() {
      return { results: stmt.stmt.all(...bound), success: true, meta: {} };
    },
    run() {
      const info = stmt.stmt.run(...bound);
      return { results: [], success: true, meta: { changes: Number(info.changes) } };
    },
    first() {
      const rows = stmt.stmt.all(...bound);
      return { result: rows[0] ?? null, success: true, meta: {} };
    },
    stmt: sqlite.prepare(normalizeSql(sql)),
  };
  return stmt;
}

const DB = {
  prepare: (sql) => prepare(sql),
  batch: async (statements) => {
    sqlite.exec("BEGIN");
    try {
      const out = statements.map((statement) => statement.run());
      sqlite.exec("COMMIT");
      return out;
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw error;
    }
  },
};

// ---- Workers AI 替身 --------------------------------------------------------
// 伪嵌入：按字符 n-gram 哈希到固定维度，保证「问题里的词越多重叠，向量越接近」，检索结果才有意义
function fakeEmbedding(text) {
  const vector = new Array(DIMENSIONS).fill(0);
  const grams = [];
  const clean = String(text).toLowerCase();
  for (let i = 0; i < clean.length - 1; i += 1) grams.push(clean.slice(i, i + 2));
  for (const word of clean.split(/[^a-z0-9_\u4e00-\u9fff]+/)) if (word.length > 1) grams.push(word);
  for (const gram of grams) {
    let hash = 2166136261;
    for (let i = 0; i < gram.length; i += 1) hash = ((hash ^ gram.charCodeAt(i)) * 16777619) >>> 0;
    vector[hash % DIMENSIONS] += 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vector.map((v) => v / norm);
}

async function runAI(model, input) {
  if (input && (Array.isArray(input.text) || typeof input.text === "string")) {
    const texts = Array.isArray(input.text) ? input.text : [input.text];
    return { data: texts.map(fakeEmbedding) };
  }
  const user = [...(input.messages ?? [])].reverse().find((m) => m.role === "user")?.content ?? "";
  const context = user.match(/【参考资料】([\s\S]*?)【问题】/)?.[1] ?? "";
  const numbered = [...context.matchAll(/【(\d+)】《([^》]+)》/g)].map(([, n, title]) => `[${n}]《${title}》`);
  const question = user.match(/【问题】\n([\s\S]*)$/)?.[1]?.trim() ?? "";
  if (!context.trim()) return { response: "知识库中没有相关信息。" };
  return {
    response: `（模拟回答，非真实模型输出）关于“${question}”：依据 ${numbered.join("、") || "[1]"} 的内容整理。部署后用真实模型替换本段。`,
    model_version: "mock",
  };
}

// ---- Vectorize 替身 --------------------------------------------------------
const vectors = new Map();
const VECTORIZE = {
  async upsert(items) {
    for (const item of items) {
      if (item.values.length !== DIMENSIONS) throw new Error(`维度不符：${item.values.length} != ${DIMENSIONS}`);
      vectors.set(item.id, item);
    }
    return { count: items.length, upsertCount: items.length, modifyCount: 0 };
  },
  async query(vector, options = {}) {
    const scored = [];
    for (const [id, item] of vectors) {
      let dot = 0;
      for (let i = 0; i < vector.length; i += 1) dot += vector[i] * item.values[i];
      scored.push({ id, score: dot, metadata: item.metadata ?? {} });
    }
    scored.sort((a, b) => b.score - a.score);
    return { matches: scored.slice(0, options.topK ?? 10), count: scored.length };
  },
  async deleteByIds(ids) {
    for (const id of ids) vectors.delete(id);
    return { deleteCount: ids.length };
  },
};

const env = {
  DB,
  AI: { run: runAI },
  VECTORIZE,
  ASSETS: {
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      const file = path === "/" ? "index.html" : path.replace(/^\/+/, "");
      try {
        const body = readFileSync(new URL(`../public/${file}`, import.meta.url));
        const type = file.endsWith(".css") ? "text/css" : file.endsWith(".js") ? "text/javascript" : "text/html";
        return new Response(body, { headers: { "content-type": `${type}; charset=utf-8` } });
      } catch {
        return new Response("Not found", { status: 404 });
      }
    },
  },
  EMBEDDING_MODEL: process.env.EMBEDDING_MODEL || "@cf/mock/bge-m3",
  EMBEDDING_DIMENSIONS: String(DIMENSIONS),
  CHAT_MODEL: process.env.CHAT_MODEL || "@cf/mock/llama",
  TOP_K: "6",
  CHUNK_MAX_CHARS: "600",
  CHUNK_OVERLAP_CHARS: "120",
  MAX_DOC_CHARS: "200000",
  MAX_CONTEXT_CHARS: "12000",
  ADMIN_TOKEN: process.env.ADMIN_TOKEN || "",
};

const port = Number(process.argv[2]) || 8790;
createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const request = new Request(`http://127.0.0.1:${port}${req.url}`, {
    method: req.method,
    headers: new Headers(req.headers),
    body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks),
  });
  const response = await worker.fetch(request, env, {});
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(port, "127.0.0.1", () => {
  console.log(`✓ mock 服务已启动：http://127.0.0.1:${port}  （AI/Vectorize 为本地模拟，仅用于验证流程）`);
});
