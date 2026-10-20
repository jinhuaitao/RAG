// 已知向量模型的维度。维度是模型自己的属性，跟在哪个平台上跑无关：
// bge-m3 在 Workers AI 和硅基流动上都是 1024 维，所以索引该建多少维不必探测，
// 从模型名就能推出来——换模型时也不用手动同步 EMBEDDING_DIMENSIONS。
const DIMENSIONS = new Map([
  ["bge-m3", 1024],
  ["bge-large-zh-v1.5", 1024],
  ["bge-small-zh-v1.5", 512],
  ["bge-base-zh-v1.5", 768],
  ["bge-large-en-v1.5", 1024],
  ["bge-small-en-v1.5", 384],
  ["bge-base-en-v1.5", 768],
  ["multilingual-e5-large", 1024],
  ["text-embedding-3-small", 1536],
  ["text-embedding-3-large", 3072],
  ["qwen3-embedding-8b", 4096],
]);

// Workers AI 上有的向量模型。第三方平台没有这个模型时，可以自动改走 Cloudflare 自家的。
const WORKERS_AI_MODELS = new Set([
  "bge-m3",
  "bge-large-zh-v1.5",
  "bge-small-zh-v1.5",
  "bge-base-zh-v1.5",
  "bge-large-en-v1.5",
  "bge-small-en-v1.5",
  "bge-base-en-v1.5",
  "multilingual-e5-large",
]);

// 归一化模型名：去掉 @cf/ 前缀与 BAAI/ 厂商前缀，转小写。
// 用户填 BAAI/bge-m3、bge-m3、@cf/baai/bge-m3 指的都是同一个模型。
export function modelKey(model) {
  return String(model || "")
    .trim()
    .toLowerCase()
    .replace(/^@cf\//, "")
    .replace(/^baai\//, "");
}

// 已知模型返回它的向量维度，未知模型返回 0
export function modelDimensions(model) {
  return DIMENSIONS.get(modelKey(model)) ?? 0;
}

// 是不是 Workers AI 上有的向量模型
export function isWorkersAiEmbeddingModel(model) {
  return WORKERS_AI_MODELS.has(modelKey(model));
}
