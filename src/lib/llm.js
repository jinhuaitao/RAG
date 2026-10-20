import { HttpError } from "./http.js";
import { normalizeModel as normalizeWorkersAiModel, workersAiEmbeddings } from "./workersai.js";

// 第三方 OpenAI 兼容接口：嵌入与生成都走这里，Worker 不再依赖 Workers AI 绑定。
// 约定：API_URL 填到 /v1 这一层（如 https://api.openai.com/v1），API_KEY 作为 Secret 配置。
// 兼容面：OpenAI、DeepSeek、硅基流动、通义千问 compatible-mode、OneAPI/NewAPI 聚合站、Ollama 等。

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_CHAT_TOKENS = 32_000;

export function apiBase(env) {
  const raw = String(env.API_URL || "").trim();
  if (!raw) {
    throw new HttpError(503, "还没有配置第三方模型接口地址（API_URL）", {
      hint: [
        "在 Workers 控制台 Settings → Variables and Secrets 里添加变量 API_URL，填第三方平台的接口根地址，例如 https://api.openai.com/v1",
        "再添加一个 Secret 类型的 API_KEY（第三方平台的密钥）",
        "改完点 Retry deployment 重新部署，然后刷新本页",
      ],
    });
  }
  let base = raw.replace(/\/+$/, "");
  // 允许直接把完整端点粘进来
  base = base.replace(/\/(?:chat\/completions|completions|embeddings)$/i, "");
  let url;
  try {
    url = new URL(base);
  } catch {
    throw new HttpError(503, `API_URL 不是合法网址：${raw}`, { hint: ["API_URL 应该形如 https://api.openai.com/v1"] });
  }
  // 域名下不带版本段时补上 /v1；带路径的（如 /compatible-mode/v1）原样使用
  if (!/\/v\d+(?:\/|$)/.test(url.pathname) && (url.pathname === "" || url.pathname === "/")) base = `${base}/v1`;
  return base;
}

export function apiHost(env) {
  try {
    return new URL(String(env.API_URL || "").trim()).host;
  } catch {
    return "";
  }
}

// 嵌入走哪个提供方：EMBEDDING_PROVIDER 说了算；没写就看模型 ID——@cf/ 开头的是 Workers AI 的模型
export function embeddingProvider(env) {
  const explicit = String(env.EMBEDDING_PROVIDER || "").trim().toLowerCase();
  if (explicit === "workers-ai" || explicit === "workersai" || explicit === "cf") return "workers-ai";
  if (explicit === "third-party" || explicit === "thirdparty" || explicit === "openai") return "third-party";
  return String(env.EMBEDDING_MODEL || "").trim().startsWith("@cf/") ? "workers-ai" : "third-party";
}

// 有些聚合站只提供对话模型，没有向量模型；这时可以单独指定做嵌入的平台
export function embeddingApiHost(env) {
  if (embeddingProvider(env) === "workers-ai") {
    try {
      return new URL(String(env.CF_API_BASE || "https://api.cloudflare.com/client/v4")).host;
    } catch {
      return "api.cloudflare.com";
    }
  }
  const url = String(env.EMBEDDING_API_URL || "").trim();
  if (!url) return apiHost(env);
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

export function isConfigured(env) {
  return Boolean(String(env.API_URL || "").trim() && String(env.API_KEY || "").trim());
}

function authHeaders(env, keyOverride) {
  const key = String(keyOverride ?? env.API_KEY ?? "").trim();
  if (!key) {
    throw new HttpError(503, "还没有配置第三方模型密钥（API_KEY）", {
      hint: [
        "在 Workers 控制台 Settings → Variables and Secrets 里添加 Secret 类型的 API_KEY，填第三方平台的密钥",
        "Secret 不会出现在代码里，也不会回传到页面",
        "改完点 Retry deployment 重新部署，然后刷新本页",
      ],
    });
  }
  const name = String(env.API_KEY_HEADER || "authorization").trim() || "authorization";
  const prefix = env.API_KEY_PREFIX === undefined ? "Bearer " : String(env.API_KEY_PREFIX);
  return { [name]: `${prefix}${key}` };
}

// 嵌入走哪个平台：EMBEDDING_API_URL / EMBEDDING_API_KEY 没配就用主接口的那一套
function embeddingTarget(env) {
  const url = String(env.EMBEDDING_API_URL || "").trim();
  const key = String(env.EMBEDDING_API_KEY || "").trim();
  const fallbackKey = String(env.API_KEY || "").trim();
  if (!url && !String(env.API_URL || "").trim()) {
    throw new HttpError(503, "还没有配置嵌入用的接口地址（EMBEDDING_API_URL 或 API_URL）", {
      hint: [
        "在 Workers 控制台 Settings → Variables and Secrets 里添加变量 EMBEDDING_API_URL（向量接口根地址，填到 /v1 这一层）",
        "只配 API_URL 也可以：这时嵌入和生成用同一个平台",
        "改完点 Retry deployment 重新部署，然后刷新本页",
      ],
    });
  }
  return {
    base: url ? apiBase({ API_URL: url }) : apiBase(env),
    key: key || fallbackKey,
    separate: Boolean(url),
  };
}

// 聚合站常把上游的 JSON 原文拼进 message 里，取出最内层那句人话，
// 别把 {"errors":{"message":"…"}} 这种原始 JSON 甩给用户
function innerMessage(text) {
  const source = String(text || "");
  const at = source.indexOf('"message"');
  if (at < 0) return null;
  let index = source.indexOf(":", at) + 1;
  if (index < 1) return null;
  while (index < source.length && /\s/.test(source[index])) index += 1;
  if (source[index] !== '"') return null;
  index += 1;
  let out = "";
  while (index < source.length && source[index] !== '"') {
    if (source[index] === "\\" && source[index + 1]) {
      out += source[index + 1];
      index += 2;
      continue;
    }
    out += source[index];
    index += 1;
  }
  return out.trim() || null;
}

function cleanReason(text) {
  const source = String(text || "").trim();
  const nested = innerMessage(source);
  if (!nested) return source.slice(0, 300);
  const at = source.indexOf('"message"');
  const prefix = source.slice(0, at).split("{")[0].replace(/[:\s]+$/, "").trim();
  return `${prefix ? `${prefix} ` : ""}${nested}`.slice(0, 300);
}

function providerMessage(payload, text) {
  let reason;
  if (typeof payload?.error === "string" && payload.error) reason = payload.error;
  else if (payload?.error?.message) reason = payload.error.message;
  else if (payload?.error?.code) reason = payload.error.code;
  // 聚合站（one-api / new-api 这类）把各渠道的失败包成 errors 对象，不是 errors 数组
  else if (payload?.errors?.message) reason = payload.errors.message;
  else if (Array.isArray(payload?.errors) && payload.errors[0]?.message) reason = payload.errors[0].message;
  else if (payload?.message) reason = payload.message;
  else if (payload?.detail) reason = payload.detail;
  else reason = text;
  return cleanReason(reason);
}

// 上游抱怨「角色不合法 / 最后一条必须是 user」：说明这个网关不认标准的 system+user 形状
const SHAPE_ERROR = /role must be|last message|must be user|invalid role|unsupported role/i;
// 上游抱怨生成参数不认（max_tokens / temperature）：换个参数形状再试
const PARAM_ERROR = /max_tokens|max_completion_tokens|temperature/i;
// 聚合站把各渠道的失败包在 5xx 里返回（"所有渠道均失败: 魔搭社区: HTTP 400 …"），
// 真正的状态码藏在文本里，不能按外层状态码当成服务端故障
const AGGREGATOR = /所有渠道均失败|所有渠道失败|all channels failed/i;
// 上游说「这个模型不存在」：多半是把聊天模型当成了嵌入模型，或模型 ID 写错
const MODEL_MISSING = /model not found|no such model|unknown model|invalid model|模型不存在|没有这个模型|model_not_found|unsupported model/i;
// 聚合站说「没有可用渠道」：模型 ID 不在它登记的名单里（多半是少了渠道后缀）
const NO_CHANNEL = /没有可用渠道|no available channel|no_channel|no available channel/i;
// 名字里带这些片段的，多半是向量化模型（平台一般不给聊天模型起这种名字）
const EMBEDDING_NAME = /embedding|embed|bge|gte|e5|m3e|jina|nomic|mxbai|bce|stella|gritlm|conan|paraphrase|granite/i;

// 平台侧的模型清单：上游说模型不存在时，直接用它告诉用户该填哪个
export async function listModelIds(env, target = null) {
  let response;
  try {
    response = await fetch(`${target?.base ?? apiBase(env)}/models`, {
      headers: authHeaders(env, target?.key),
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    return [];
  }
  if (!response.ok) return [];
  try {
    const payload = await response.json();
    const list = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : Array.isArray(payload) ? payload : [];
    return list.map((item) => (typeof item === "string" ? item : item?.id)).filter((id) => typeof id === "string" && id.trim());
  } catch {
    return [];
  }
}

function pickModels(ids, kind) {
  const embeddingLike = ids.filter((id) => EMBEDDING_NAME.test(id));
  const chatLike = ids.filter((id) => !EMBEDDING_NAME.test(id));
  if (kind === "embedding") return embeddingLike.length ? embeddingLike : chatLike;
  return chatLike.length ? chatLike : embeddingLike;
}

// 上游说「模型不存在」或「没有可用渠道」时，别只回一句「模型 ID 不存在」：
// 把当前填的是哪个变量、平台上到底有哪些模型、维度要怎么跟着改，一次说清
async function modelMissingError(env, kind, model, reason, mode = "missing") {
  const target = kind === "embedding" ? embeddingTarget(env) : null;
  const ids = await listModelIds(env, target);
  const isEmbedding = kind === "embedding";
  const label = isEmbedding ? "嵌入模型" : "生成模型";
  const variable = isEmbedding ? "EMBEDDING_MODEL" : "CHAT_MODEL";
  const embeddingLike = ids.filter((id) => EMBEDDING_NAME.test(id));
  const candidates = pickModels(ids, kind);

  const hint = [`当前 ${variable} = ${model}`];
  if (mode === "noChannel") {
    if (isEmbedding) {
      hint.push("这个平台上没有这个嵌入模型：聚合站的对话渠道挂了它，但没人提供向量接口");
      hint.push("或者把 EMBEDDING_MODEL 改成 @cf/baai/bge-m3：嵌入改走 Cloudflare 自带的 Workers AI（1024 维），不需要额外的密钥");
    } else {
      hint.push("模型 ID 要用平台上登记的完整名称，聚合站常给同一个模型挂不同渠道后缀（例如 DeepSeek-V4-Flash(AMD)）");
    }
  } else if (isEmbedding) {
    hint.push("嵌入模型要能输出向量，聊天模型不能用来做嵌入（DeepSeek / GPT / Claude 这类只能回答问题）");
  } else {
    hint.push("生成模型要能回答问题，嵌入模型不能用来生成回答");
  }
  if (isEmbedding && String(env.CHAT_MODEL || "").trim() === model) {
    hint.push("EMBEDDING_MODEL 和 CHAT_MODEL 填成了同一个模型 —— 这两个必须是两个不同的模型");
  }

  const noEmbedding = isEmbedding && ids.length > 0 && embeddingLike.length === 0;
  if (noEmbedding) {
    // 平台上根本没有向量模型：别把对话模型列成「可用的嵌入模型」
    hint.push(`这个平台的清单里一个向量模型都没有（只有 ${ids.slice(0, 6).join("、")} 这类对话模型）—— 入库没法在它上面做`);
    hint.push("另配一个能嵌入的平台：控制台加 EMBEDDING_API_URL（向量接口根地址）与 EMBEDDING_API_KEY（那个平台的密钥），嵌入走它、生成仍走现在的平台");
    hint.push("或者把 EMBEDDING_MODEL 改成 @cf/baai/bge-m3：嵌入改走 Cloudflare 自带的 Workers AI（1024 维），不需要额外的密钥");
  } else if (candidates.length) {
    hint.push(`这个平台上可用的${label}：${candidates.slice(0, 8).join("、")}`);
  } else if (ids.length) {
    hint.push(`这个平台返回了 ${ids.length} 个模型，但没找到常见的${label}，确认平台上是否提供向量模型`);
  } else {
    hint.push("拉不到平台模型清单，用 curl 看一眼：curl <API_URL>/models -H 'authorization: Bearer <API_KEY>'");
  }
  if (isEmbedding) {
    hint.push("入库走的 /embeddings 地址没错，问题在模型 ID：嵌入必须用向量模型");
    hint.push("换模型要同步改 EMBEDDING_DIMENSIONS（bge-m3=1024、text-embedding-3-small=1536、Qwen3-Embedding-8B=4096）");
    hint.push("改完重新部署，点「初始化资源」按新维度重建索引");
  } else if (candidates.length) {
    hint.push(`改完把控制台变量 ${variable} 改成上面的名字，再重新部署即可`);
  }
  if (AGGREGATOR.test(reason)) {
    hint.push("「所有渠道均失败」说明是聚合站逐个渠道转发：这个模型在它挂的渠道里都不是向量模型");
  }
  const title = mode === "noChannel" ? `第三方平台没有这个${label}的可用渠道：${reason}` : `第三方平台没有这个${label}：${reason}`;
  return new HttpError(502, title, { hint });
}

// 把上游返回的失败翻译成能直接照着做的中文提示：分清「不可改的」与「可修的」
function providerError(status, payload, text, url) {
  const error = buildProviderError(status, payload, text, url);
  // 上游原话单独挂一份：判断「是不是模型不存在」要看上游说了什么，
  // 不能看我们自己拼的中文提示（里面也有「模型不存在」几个字）
  error.providerReason = providerMessage(payload, text);
  return error;
}

function buildProviderError(status, payload, text, url) {
  const reason = providerMessage(payload, text);
  const haystack = `${reason}\n${text ?? ""}`;
  const extra = AGGREGATOR.test(haystack)
    ? ["报错里出现「所有渠道均失败」说明你用的是聚合站：它会逐个渠道转发，每个渠道支持的模型与请求格式都不同"]
    : [];

  if (SHAPE_ERROR.test(haystack)) {
    return new HttpError(502, `第三方接口不接受当前的对话格式：${reason}`, {
      hint: [
        "上游要求 role 只能是 user/assistant/system，且最后一条消息的 role 必须是 user",
        "本项目已自动改成「只发一条 user 消息」重试，仍被拒绝，说明这个网关还有别的格式要求",
        ...extra,
        "换 CHAT_MODEL，或把 API_URL 换成该平台的直连兼容地址再试",
      ],
    });
  }

  // 模型 ID 不在平台名单里：这是配置错了，不是服务故障，单独标出来
  if (NO_CHANNEL.test(haystack)) {
    const error = new HttpError(502, `第三方平台没有这个模型的可用渠道：${reason}`, {
      hint: ["模型 ID 要用平台上登记的完整名称，聚合站常给同一模型挂不同渠道后缀"],
    });
    error.noChannel = true;
    return error;
  }

  // 聚合站返回的 5xx 里裹着上游的 4xx，按文本里挖到的状态码判断，别一律当成服务端故障
  const embedded = haystack.match(/HTTP\s*(\d{3})/i);
  const effective = embedded ? Number(embedded[1]) : status;

  if (effective === 401 || effective === 403) {
    return new HttpError(502, `第三方接口鉴权失败（HTTP ${effective}）：${reason}`, {
      hint: [
        "检查 API_KEY 是否正确、是否已过期、账户是否还有余额",
        "确认这个 Key 有权调用你配置的 EMBEDDING_MODEL / CHAT_MODEL",
        "部分平台要求用「sk-」开头的 Key，注意不要把平台地址或多余引号一起粘进去",
        ...extra,
      ],
    });
  }
  if (effective === 404) {
    return new HttpError(502, `第三方接口地址或模型不存在（HTTP 404）：${reason}`, {
      hint: [
        "检查 API_URL 是否填到 /v1 这一层，例如 https://api.openai.com/v1",
        "检查 EMBEDDING_MODEL / CHAT_MODEL 的模型 ID 在该平台上是否存在",
        "有些平台给自有模型起别名，先在平台文档里确认准确的模型名",
        ...extra,
      ],
    });
  }
  if (effective === 429) {
    return new HttpError(429, `第三方接口限流或额度不足（HTTP 429）：${reason}`, {
      hint: [
        "稍等几秒重试，平台通常按分钟恢复",
        "检查账户余额与该模型的可用额度，嵌入与生成分别计费",
        ...extra,
      ],
    });
  }
  if (effective >= 500) {
    return new HttpError(502, `第三方接口返回 ${effective}：${reason}`, {
      hint: ["上游服务异常，等一会儿重试", "若持续出现，核对 API_URL 是否指向了正确的平台地址", ...extra],
    });
  }
  return new HttpError(502, `第三方接口拒绝了这次请求（HTTP ${effective}）：${reason}`, {
    hint: [
      `请求地址：${url}`,
      "常见原因：模型 ID 不存在、上下文超长、参数不被该模型支持",
      ...extra,
    ],
  });
}

async function callApi(env, path, body, target = null) {
  const base = target?.base ?? apiBase(env);
  const url = `${base}${path}`;
  const headers = { "content-type": "application/json", ...authHeaders(env, target?.key) };
  const timeout = Math.min(MAX_TIMEOUT_MS, Math.max(5_000, Number(env.API_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const reason = String(error?.message ?? error);
    if (error?.name === "AbortError" || /abort/i.test(reason)) {
      throw new HttpError(504, `调用第三方接口超时（${Math.round(timeout / 1000)} 秒）：${url}`, {
        hint: [
          "把控制台变量 API_TIMEOUT_MS 调大（当前 " + timeout + " 毫秒）",
          "推理模型出答案较慢时可调到 120000",
          "也可以把 CHAT_MAX_TOKENS 调小，缩短生成时间",
        ],
      });
    }
    throw new HttpError(502, `无法连接第三方接口 ${url}：${reason}`, {
      hint: [
        "确认 API_URL 拼写正确、域名可访问",
        "确认平台没有限制该来源，或换用平台提供的兼容地址",
      ],
    });
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const error = providerError(response.status, payload, text, url);
    error.providerStatus = response.status;
    throw error;
  }
  if (!payload || typeof payload !== "object") {
    throw new HttpError(502, `第三方接口返回了无法解析的内容（${path}）`, {
      hint: ["确认 API_URL 指向的是 OpenAI 兼容的接口根地址，而不是网页地址"],
    });
  }
  // 有些平台出错时仍回 200，错误体塞在 error 字段里
  if (payload.error && !payload.choices && !payload.data) {
    const error = providerError(400, payload, text, url);
    error.providerStatus = 400;
    throw error;
  }
  return payload;
}

function readContent(payload) {
  const choice = payload?.choices?.[0];
  const message = choice?.message;
  let content = message?.content;
  if (Array.isArray(content)) {
    content = content.map((part) => (typeof part === "string" ? part : part?.text || "")).join("");
  }
  if (typeof content !== "string") content = "";
  const reasoning = message?.reasoning_content ?? choice?.reasoning ?? payload?.reasoning_content ?? "";
  return { content, reasoning: typeof reasoning === "string" ? reasoning : "" };
}

// 推理模型把思考写进 reasoning_content，正文在 content；部分平台两者混在一个字段里
function stripThink(text) {
  const open = ["<", "think", ">"].join("");
  const close = ["<", "/", "think", ">"].join("");
  const end = text.lastIndexOf(close);
  // 只有开标记没有闭标记：思考被截断，正文根本没写出来
  if (end < 0) return { text: text.includes(open) ? "" : text, truncated: text.includes(open) };
  return { text: text.slice(end + close.length).replace(/^[\s:：]+/, ""), truncated: false };
}

// 有些网关（魔搭社区、部分聚合站）只收「最后一条 role 必须是 user」的消息，
// system 提示词必须并进 user 消息里才认
function asSingleUser(messages) {
  const text = messages
    .map((message) => {
      if (message.role === "system") return message.content;
      if (message.role === "user") return message.content;
      return `[${message.role}]\n${message.content}`;
    })
    .join("\n\n");
  return [{ role: "user", content: text }];
}

// 通义千问 compatible-mode 一类网关按内容分片解析
function asParts(messages) {
  return messages.map((message) => ({
    role: message.role,
    content: [{ type: "text", text: message.content }],
  }));
}

// 不同平台对生成参数的要求不一样：老的收 max_tokens，新的推理模型只收 max_completion_tokens，
// 还有的只允许默认 temperature；有网关还不认 system + user 的多轮形状。
// 按报错内容决定下一个形状，逐级退到上游能接受的那个。
const CHAT_VARIANTS = [
  { id: "standard", build: (model, messages, temperature, max) => ({ model, messages, temperature, max_tokens: max }) },
  { id: "max-completion-tokens", build: (model, messages, temperature, max) => ({ model, messages, max_completion_tokens: max }) },
  { id: "bare", build: (model, messages) => ({ model, messages }) },
  { id: "single-user", build: (model, messages) => ({ model, messages: asSingleUser(messages) }) },
  { id: "single-user-parts", build: (model, messages) => ({ model, messages: asParts(asSingleUser(messages)) }) },
];

const PARAM_FALLBACKS = ["max-completion-tokens", "bare"];
const SHAPE_FALLBACKS = ["single-user", "single-user-parts"];

// 同一个网关不会每次都换口味：记住上次成功的形状，下次直接用它，省掉一次试探性失败
const preferredShapes = new Map();

function nextVariant(reason, tried) {
  const order = [];
  if (SHAPE_ERROR.test(reason)) order.push(...SHAPE_FALLBACKS);
  if (PARAM_ERROR.test(reason)) order.push(...PARAM_FALLBACKS);
  for (const id of order) {
    if (!tried.has(id)) return CHAT_VARIANTS.find((variant) => variant.id === id);
  }
  return null;
}

export async function chatCompletion(env, { messages, temperature = 0.2, maxTokens }) {
  const model = String(env.CHAT_MODEL || "").trim();
  if (!model) {
    throw new HttpError(503, "还没有配置生成模型（CHAT_MODEL）", {
      hint: [
        "在控制台 Settings → Variables and Secrets 里加一个变量 CHAT_MODEL，填第三方平台上的模型 ID，例如 gpt-4o-mini、deepseek-chat、qwen-plus",
        "保存后点 Retry deployment 重新部署，再刷新页面",
      ],
    });
  }
  const max = Math.min(MAX_CHAT_TOKENS, Math.max(1, Number(maxTokens) || 1500));
  const shapeKey = `${apiBase(env)}|${model}`;
  let lastError = null;
  const tried = new Set();
  let variant = CHAT_VARIANTS.find((item) => item.id === preferredShapes.get(shapeKey)) ?? CHAT_VARIANTS[0];
  while (variant) {
    tried.add(variant.id);
    let payload;
    try {
      payload = await callApi(env, "/chat/completions", variant.build(model, messages, temperature, max));
    } catch (error) {
      const reason = String(error?.providerReason ?? error?.message ?? error);
      // 模型不存在 / 没有可用渠道时换请求形状也没用，直接说清楚该改哪个变量
      if (error?.noChannel) throw await modelMissingError(env, "chat", model, reason, "noChannel");
      if (MODEL_MISSING.test(reason)) throw await modelMissingError(env, "chat", model, reason);
      lastError = error;
      variant = nextVariant(reason, tried);
      continue;
    }
    const { content, reasoning } = readContent(payload);
    const raw = content || reasoning;
    if (!raw.trim()) {
      throw new HttpError(502, `生成模型 ${model} 没有返回正文`, {
        hint: ["上游返回了空内容，换一个模型或稍后重试", "若平台对内容做了过滤，试试调整提问措辞"],
      });
    }
    const stripped = stripThink(raw);
    if (!stripped.text.trim()) {
      throw new HttpError(502, `生成模型 ${model} 只返回了思考过程，正文为空`, {
        hint: [
          "思考过程的 token 也算在 CHAT_MAX_TOKENS 里，当前配置是 " + max,
          "把控制台变量 CHAT_MAX_TOKENS 调到 2500–3000 再重新部署",
          "或换用非推理模型（提示词已限制 500 字，但思考长度由模型自己决定）",
        ],
      });
    }
    preferredShapes.set(shapeKey, variant.id);
    return {
      content: stripped.text.trim(),
      truncated: stripped.truncated,
      model: payload?.model || model,
      usage: {
        prompt_tokens: Number(payload?.usage?.prompt_tokens ?? 0),
        completion_tokens: Number(payload?.usage?.completion_tokens ?? 0),
        total_tokens: Number(payload?.usage?.total_tokens ?? 0),
      },
    };
  }
  throw lastError ?? new HttpError(502, "生成模型调用失败");
}

export async function embeddings(env, texts) {
  const model = String(env.EMBEDDING_MODEL || "").trim();
  if (!model) {
    throw new HttpError(503, "还没有配置嵌入模型（EMBEDDING_MODEL）", {
      hint: [
        "在控制台 Settings → Variables and Secrets 里加一个变量 EMBEDDING_MODEL，填第三方平台上的嵌入模型 ID，例如 text-embedding-3-small、BAAI/bge-m3",
        "用 Workers AI 的话填 @cf/baai/bge-m3（1024 维），不需要额外的模型密钥",
        "换模型会改变向量维度，必须同时改 EMBEDDING_DIMENSIONS 并重建向量索引",
      ],
    });
  }
  // Workers AI 是 Cloudflare 自家的向量模型，走 Cloudflare 的 REST API，不需要额外的模型密钥
  if (embeddingProvider(env) === "workers-ai") return workersAiEmbeddings(env, texts);
  const target = embeddingTarget(env);
  if (!target.key) {
    throw new HttpError(503, "还没有配置嵌入用的密钥（EMBEDDING_API_KEY 或 API_KEY）", {
      hint: [
        "在 Workers 控制台 Settings → Variables and Secrets 里添加 Secret 类型的 API_KEY（生成用）或 EMBEDDING_API_KEY（嵌入用）",
        "如果生成和嵌入用的是两个平台，就再填 EMBEDDING_API_URL（向量接口根地址）与 EMBEDDING_API_KEY",
        "改完点 Retry deployment 重新部署，然后刷新本页",
      ],
    });
  }
  let payload;
  try {
    payload = await callApi(env, "/embeddings", { model, input: texts }, target);
  } catch (error) {
    const reason = String(error?.providerReason ?? error?.message ?? error);
    if (error?.noChannel) throw await modelMissingError(env, "embedding", model, reason, "noChannel");
    if (MODEL_MISSING.test(reason)) throw await modelMissingError(env, "embedding", model, reason);
    throw error;
  }
  const data = payload?.data;
  if (!Array.isArray(data) || data.length !== texts.length) {
    throw new HttpError(502, `嵌入接口返回异常：期望 ${texts.length} 条向量，实际 ${Array.isArray(data) ? data.length : "无"}`, {
      hint: [
        `模型 ${model} 在该平台上可能不支持批量输入`,
        "确认 EMBEDDING_MODEL 是嵌入模型而不是对话模型",
      ],
    });
  }
  // 部分平台不保证按顺序返回，按 index 排回来
  const sorted = [...data].sort((a, b) => (Number(a?.index) || 0) - (Number(b?.index) || 0));
  return sorted.map((item) => item?.embedding);
}
