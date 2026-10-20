// 端到端验证：真实 Worker 代码 + 假 Cloudflare API + 假模型接口
// 覆盖「初始化 → 入库 → 检索 → 问答 → 索引维度不符 → 重建 → 重新嵌入 → 检索仍可用」
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const PORT = Number(process.argv[2] || 8890);
const API_PORT = PORT + 1;
const BASE = `http://127.0.0.1:${PORT}`;
const CF_BASE = `http://127.0.0.1:${API_PORT}/client/v4`;
const ACCOUNT = "mock-account-0000";
const ADMIN = "mock-token";
const LLM_KEY = "mock-llm-key";
const INDEX = "rag-kb-index";

const cases = [];
function test(name, fn) {
  cases.push([name, fn]);
}

let child = null;

async function startMock(extraEnv = {}) {
  child = spawn(process.execPath, [new URL("./dev-mock.mjs", import.meta.url).pathname, String(PORT)], {
    env: { ...process.env, ...extraEnv },
    stdio: ["ignore", "ignore", "inherit"],
  });
  for (let i = 0; i < 100; i += 1) {
    try {
      const response = await fetch(`${BASE}/api/status`);
      if (response.ok) return;
    } catch {
      // 还没起来
    }
    await delay(100);
  }
  throw new Error("mock 服务没能在 10 秒内就绪");
}

function stopMock() {
  if (child) {
    child.kill();
    child = null;
  }
}

async function app(path, options = {}) {
  const headers = { authorization: `Bearer ${ADMIN}`, ...(options.headers || {}) };
  const response = await fetch(`${BASE}${path}`, { ...options, headers });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

async function cloudflare(path, options = {}) {
  const headers = { authorization: `Bearer ${ADMIN}`, ...(options.headers || {}) };
  const response = await fetch(`${CF_BASE}${path}`, { ...options, headers });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

// 假模型接口只认自己的密钥
async function embed(text) {
  const response = await fetch(`http://127.0.0.1:${API_PORT}/v1/embeddings`, {
    method: "POST",
    headers: { authorization: `Bearer ${LLM_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "mock/bge-m3", input: [text] }),
  });
  const body = await response.json();
  return body.data[0].embedding;
}

async function indexVectorCount() {
  const vector = await embed("退货政策");
  const response = await fetch(
    `http://127.0.0.1:${API_PORT}/client/v4/accounts/${ACCOUNT}/vectorize/v2/indexes/${INDEX}/query`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
      body: JSON.stringify({ topK: 1000, vector }),
    }
  );
  const body = await response.json();
  return body?.result?.matches?.length ?? 0;
}

const POLICY = `退货政策说明

一、退货条件
定制类商品不支持七天无理由退货。商品需保持完好、不影响二次销售，包装、赠品、配件齐全。
自签收次日起七天内可发起退货申请，逾期系统不再受理。

二、退款到账
退货申请需要在签收后七天内提交，逾期不再受理。退款审核通过后，款项按原支付路径退回。
银行卡到账通常需要 3 到 5 个工作日，账户余额即时到账。`;

function longPolicy(target) {
  const parts = [POLICY];
  while (parts.join("\n").length < target) parts.push(POLICY);
  return parts.join("\n\n");
}

test("端到端：初始化 → 入库 → 检索 → 问答", async () => {
  await startMock();
  const setup = await app("/api/admin/setup", { method: "POST" });
  assert.equal(setup.status, 200, JSON.stringify(setup.body));
  assert.ok(setup.body.steps.some((step) => step.step === "vectorize" && step.action === "create"), JSON.stringify(setup.body.steps));

  const ingest = await app("/api/documents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "退货政策", text: POLICY }),
  });
  assert.equal(ingest.status, 201, JSON.stringify(ingest.body));
  assert.ok(ingest.body.chunkCount >= 1, JSON.stringify(ingest.body));

  const ask = await app("/api/ask", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question: "退货申请几天内提交？" }),
  });
  assert.equal(ask.status, 200, JSON.stringify(ask.body));
  assert.ok(ask.body.sources?.length, JSON.stringify(ask.body));
  assert.ok(!ask.body.noContext, JSON.stringify(ask.body));

  const docs = await app("/api/documents");
  assert.equal(docs.body.counts.docs, 1, JSON.stringify(docs.body.counts));
});

test("端到端：索引维度与配置不符时，重建并重新嵌入，文档不用重传", async () => {
  // 造一个跟配置（1536）不符的旧索引，模拟换嵌入模型后留下的残骸
  const del = await cloudflare(`/accounts/${ACCOUNT}/vectorize/v2/indexes/${INDEX}`, { method: "DELETE" });
  assert.equal(del.status, 200, JSON.stringify(del.body));
  const create = await cloudflare(`/accounts/${ACCOUNT}/vectorize/v2/indexes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: INDEX, config: { dimensions: 1024, metric: "cosine" } }),
  });
  assert.equal(create.status, 200, JSON.stringify(create.body));

  // 状态里要看得出来
  const status = await app("/api/status");
  assert.equal(status.body.provision.index.mismatch, true, JSON.stringify(status.body.provision));
  assert.equal(status.body.provisioned, false, JSON.stringify(status.body.provision));

  // 初始化资源应当自动重建，而不是甩一个 409 让用户去控制台删
  const setup = await app("/api/admin/setup", { method: "POST" });
  assert.equal(setup.status, 200, JSON.stringify(setup.body));
  const rebuild = setup.body.steps.find((step) => step.step === "vectorize" && step.action === "rebuild");
  assert.ok(rebuild, JSON.stringify(setup.body.steps));
  assert.ok(/1024/.test(rebuild.detail), rebuild.detail);

  const index = await cloudflare(`/accounts/${ACCOUNT}/vectorize/v2/indexes/${INDEX}`);
  assert.equal(index.body.result.config.dimensions, 1536, JSON.stringify(index.body.result));

  // 原文还在库里，向量已经重新嵌入
  const docs = await app("/api/documents");
  assert.equal(docs.body.counts.docs, 1, JSON.stringify(docs.body.counts));
  const chunkCount = docs.body.counts.chunks;
  assert.ok(chunkCount >= 1, JSON.stringify(docs.body.counts));
  assert.equal(await indexVectorCount(), chunkCount, "重建后向量数量要与片段数一致");

  const ask = await app("/api/ask", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question: "退货申请几天内提交？" }),
  });
  assert.equal(ask.status, 200, JSON.stringify(ask.body));
  assert.ok(ask.body.sources?.length, "重建后仍要能检索到");
});

test("端到端：片段多到一次做不完时，分批重新嵌入直到完成", async () => {
  const long = longPolicy(120_000);
  const ingest = await app("/api/documents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "退货政策全文", text: long }),
  });
  assert.equal(ingest.status, 201, JSON.stringify(ingest.body));
  const docs = await app("/api/documents");
  const chunkCount = docs.body.counts.chunks;
  assert.ok(chunkCount > 150, `片段数要超过单页上限才能验证分批，实际 ${chunkCount}`);

  await cloudflare(`/accounts/${ACCOUNT}/vectorize/v2/indexes/${INDEX}`, { method: "DELETE" });
  await cloudflare(`/accounts/${ACCOUNT}/vectorize/v2/indexes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: INDEX, config: { dimensions: 1024, metric: "cosine" } }),
  });

  const setup = await app("/api/admin/setup", { method: "POST" });
  assert.equal(setup.status, 200, JSON.stringify(setup.body));
  assert.ok(setup.body.reembed.remaining > 0, `第一页之后应还有剩余，实际 ${JSON.stringify(setup.body.reembed)}`);

  let offset = setup.body.reembed.offset;
  let remaining = setup.body.reembed.remaining;
  let guard = 0;
  while (remaining > 0) {
    const page = await app("/api/admin/reembed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ offset }),
    });
    assert.equal(page.status, 200, JSON.stringify(page.body));
    assert.ok(page.body.offset > offset, `offset 要往前走：${offset} → ${page.body.offset}`);
    offset = page.body.offset;
    remaining = page.body.remaining;
    guard += 1;
    assert.ok(guard < 20, "分批次数异常");
  }
  assert.equal(await indexVectorCount(), chunkCount, "全部片段都要有向量");
});

test("端到端：模型维度与配置不符时，删索引之前就拦下来", async () => {
  stopMock();
  await startMock({ MOCK_EMBED_DIM: "1024", EMBEDDING_DIMENSIONS: "1536" });

  // 索引维度(1024) 与配置(1536) 不符，会走重建路径；
  // 但模型实际只输出 1024 维，探测阶段就该拦下来，索引不能动
  await cloudflare(`/accounts/${ACCOUNT}/vectorize/v2/indexes/${INDEX}`, { method: "DELETE" });
  await cloudflare(`/accounts/${ACCOUNT}/vectorize/v2/indexes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: INDEX, config: { dimensions: 1024, metric: "cosine" } }),
  });

  const bad = await app("/api/admin/setup", { method: "POST" });
  assert.equal(bad.status, 500, JSON.stringify(bad.body));
  assert.ok(/维度不匹配/.test(bad.body.error), JSON.stringify(bad.body));

  // 索引没被删掉：模型与配置不符时不能动用户的向量
  const index = await cloudflare(`/accounts/${ACCOUNT}/vectorize/v2/indexes/${INDEX}`);
  assert.equal(index.status, 200, JSON.stringify(index.body));
  assert.equal(index.body.result.config.dimensions, 1024, "索引应当原样保留");
});

test("端到端：嵌入走 Workers AI 时，入库与检索照常", async () => {
  stopMock();
  await startMock({ EMBEDDING_PROVIDER: "workers-ai", EMBEDDING_MODEL: "@cf/baai/bge-m3" });

  const status = await app("/api/status");
  assert.equal(status.body.config.embedding_provider, "workers-ai", JSON.stringify(status.body.config));

  const setup = await app("/api/admin/setup", { method: "POST" });
  assert.equal(setup.status, 200, JSON.stringify(setup.body));

  const ingest = await app("/api/documents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "退货政策", text: POLICY }),
  });
  assert.equal(ingest.status, 201, JSON.stringify(ingest.body));
  assert.ok(ingest.body.chunkCount >= 1, JSON.stringify(ingest.body));

  const ask = await app("/api/ask", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question: "退货申请几天内提交？" }),
  });
  assert.equal(ask.status, 200, JSON.stringify(ask.body));
  assert.ok(ask.body.sources?.length, JSON.stringify(ask.body));
  assert.ok(!ask.body.noContext, JSON.stringify(ask.body));
});

let failed = 0;
try {
  for (const [name, fn] of cases) {
    try {
      await fn();
      console.log(`✓ ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`✗ ${name}\n  ${error.message}`);
    }
  }
} finally {
  stopMock();
}
console.log(`\n${cases.length - failed}/${cases.length} 通过`);
process.exit(failed ? 1 : 0);
