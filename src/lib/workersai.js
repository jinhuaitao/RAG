// Workers AI 嵌入：走 Cloudflare 自己的 REST API，复用已有的 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID。
// 不需要额外的模型密钥，也不用在 wrangler.jsonc 里声明 AI 绑定——控制台加的绑定会被重新部署冲掉。
import { HttpError } from "./http.js";
import { credentials } from "./cfapi.js";

// Workers AI 的模型 ID 一律带 @cf/ 前缀，用户习惯填的 BAAI/bge-m3 要补上
const ALIASES = new Map([
  ["baai/bge-m3", "@cf/baai/bge-m3"],
  ["bge-m3", "@cf/baai/bge-m3"],
  ["baai/bge-large-zh-v1.5", "@cf/baai/bge-large-zh-v1.5"],
  ["baai/bge-small-zh-v1.5", "@cf/baai/bge-small-zh-v1.5"],
  ["baai/bge-base-zh-v1.5", "@cf/baai/bge-base-zh-v1.5"],
  ["baai/bge-large-en-v1.5", "@cf/baai/bge-large-en-v1.5"],
  ["baai/bge-small-en-v1.5", "@cf/baai/bge-small-en-v1.5"],
  ["baai/bge-base-en-v1.5", "@cf/baai/bge-base-en-v1.5"],
]);

// Workers AI 上常见的向量模型与维度，出现在报错里
const KNOWN_MODELS = [
  "@cf/baai/bge-m3（1024 维）",
  "@cf/baai/bge-large-en-v1.5（1024 维）",
  "@cf/baai/bge-small-en-v1.5（384 维）",
  "@cf/baai/bge-base-en-v1.5（768 维）",
];

export function normalizeModel(model) {
  const raw = String(model || "").trim();
  if (!raw) return "";
  if (raw.startsWith("@")) return raw;
  return ALIASES.get(raw.toLowerCase()) ?? `@cf/${raw}`;
}

export function modelDimensions(model) {
  const name = normalizeModel(model).toLowerCase();
  if (name.includes("bge-m3") || name.includes("large-en")) return 1024;
  if (name.includes("small-en")) return 384;
  if (name.includes("base-en")) return 768;
  return 0;
}

// bge-m3 最长 512 token，超了会被截断或直接报错。
// 先把长片段切开分别嵌入再取平均：尾巴不丢，也不撞上限。
export function splitText(text, maxChars) {
  const source = String(text ?? "");
  if (!maxChars || source.length <= maxChars) return [source];
  const pieces = [];
  let rest = source;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf("。", maxChars);
    if (cut < maxChars * 0.5) cut = rest.lastIndexOf("\n", maxChars);
    if (cut < maxChars * 0.5) cut = rest.lastIndexOf(" ", maxChars);
    if (cut < maxChars * 0.5) cut = maxChars;
    pieces.push(rest.slice(0, cut + 1));
    rest = rest.slice(cut + 1);
  }
  if (rest) pieces.push(rest);
  return pieces;
}

function encodeModel(model) {
  return String(model).replace(/[^\w@\-./]/g, (character) => encodeURIComponent(character));
}

function apiError(status, detail, model) {
  const hint = [];
  if (status === 401 || status === 403 || /authoriz|permission|token|forbidden/i.test(detail)) {
    hint.push("Cloudflare API Token 缺少 Workers AI 权限：控制台 → My Profile → API Tokens → 编辑这个 Token → Permissions 加一项 **Workers AI: Read**（Account 级别）");
    hint.push(`确认 Worker 用的就是这个 Token（控制台变量 CLOUDFLARE_API_TOKEN）`);
  } else if (status === 404 || /not found|unknown model|no such model|model_not_found/i.test(detail)) {
    hint.push(`Workers AI 上没有 ${model} 这个模型`);
    hint.push(`可用的向量模型：${KNOWN_MODELS.join("、")}`);
    hint.push(`改控制台变量 EMBEDDING_MODEL，并把 EMBEDDING_DIMENSIONS 改成对应维度`);
  } else if (status === 429 || /rate limit|too many requests/i.test(detail)) {
    hint.push("Workers AI 限流了，稍等几秒再试");
  } else if (/too long|maximum context|token limit|length/i.test(detail)) {
    hint.push("文本太长，被模型的 token 上限挡住了");
    hint.push("把控制台变量 CHUNK_MAX_CHARS 或 EMBEDDING_MAX_CHARS 调小（例如 600 → 400）");
  } else {
    hint.push("确认账号已开通 Workers AI，且这个 Token 有 Workers AI: Read 权限");
  }
  return new HttpError(status === 429 ? 429 : 502, `Workers AI 调用失败（HTTP ${status}）：${detail}`, { hint });
}

async function run(env, model, texts) {
  const { accountId, token, base } = credentials(env);
  const url = `${base}/accounts/${accountId}/ai/run/${encodeModel(model)}`;
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ text: texts }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    const reason = String(error?.message ?? error);
    throw new HttpError(502, `无法访问 Workers AI（${url}）：${reason}`, {
      hint: ["确认网络可达 api.cloudflare.com，且 API Token 没有过期"],
    });
  }

  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok || payload?.success === false) {
    const detail = payload?.errors?.[0]?.message || payload?.message || text.slice(0, 300) || response.statusText;
    throw apiError(response.status, String(detail), model);
  }
  return payload?.result;
}

// result 形状：{ data: [[...], [...]], shape: [n, dim] }；单条输入时也可能只给一条向量
function toVectors(result, count) {
  const data = result?.data;
  if (!Array.isArray(data) || !data.length) {
    throw new HttpError(502, "Workers AI 没有返回向量数据", {
      hint: ["确认 EMBEDDING_MODEL 指向的是向量模型（例如 @cf/baai/bge-m3）而不是对话模型"],
    });
  }
  if (typeof data[0] === "number") return [data];
  if (!Array.isArray(data[0])) {
    throw new HttpError(502, "Workers AI 返回的向量格式不对");
  }
  return data;
}

function mean(vectors) {
  if (vectors.length === 1) return vectors[0];
  const dimension = vectors[0]?.length ?? 0;
  const out = new Array(dimension).fill(0);
  for (const vector of vectors) {
    for (let i = 0; i < dimension; i += 1) out[i] += Number(vector[i] ?? 0);
  }
  return out.map((value) => value / vectors.length);
}

// 嵌入走 Workers AI：长文本切块后分别嵌入，同一原文的多块取平均
export async function workersAiEmbeddings(env, texts) {
  const model = normalizeModel(env.EMBEDDING_MODEL);
  if (!model) {
    throw new HttpError(503, "还没有配置嵌入模型（EMBEDDING_MODEL）", {
      hint: [
        "在控制台变量 EMBEDDING_MODEL 填 Workers AI 的向量模型，例如 @cf/baai/bge-m3",
        "它的输出是 1024 维，EMBEDDING_DIMENSIONS 也要填 1024",
      ],
    });
  }
  const maxChars = Number(env.EMBEDDING_MAX_CHARS) || 400;
  const pieces = [];
  const owners = [];
  texts.forEach((text, index) => {
    const parts = splitText(String(text ?? ""), maxChars);
    parts.forEach((part) => {
      pieces.push(part);
      owners.push(index);
    });
  });

  const vectors = [];
  for (let i = 0; i < pieces.length; i += 16) {
    const batch = pieces.slice(i, i + 16);
    const result = await run(env, model, batch);
    const data = toVectors(result, batch.length);
    if (data.length !== batch.length) {
      throw new HttpError(502, `Workers AI 返回了 ${data.length} 条向量，实际请求了 ${batch.length} 条`, {
        hint: ["分批重试一次通常能对上；若持续出现，换一个 Workers AI 向量模型"],
      });
    }
    vectors.push(...data);
  }

  // 合回每条原文：同一段被切成多块时取平均
  const grouped = new Map();
  vectors.forEach((vector, index) => {
    const owner = owners[index];
    if (!grouped.has(owner)) grouped.set(owner, []);
    grouped.get(owner).push(vector);
  });
  return texts.map((_, index) => mean(grouped.get(index) ?? []));
}
