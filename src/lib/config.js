// 环境变量的默认值集中在这里，wrangler.jsonc 里不再声明 vars。
// 这样控制台里的变量就是唯一来源：GitHub 每次触发重新部署都原样保留它们，
// 而全新部署还没有配任何变量时，靠这份默认值也能先跑起来。
export const DEFAULTS = {
  API_URL: "https://api.openai.com/v1",
  API_KEY_HEADER: "authorization",
  API_KEY_PREFIX: "Bearer ",
  API_TIMEOUT_MS: "60000",
  // 嵌入可以单独走另一个平台（有些聚合站只提供对话模型，没有向量模型）
  EMBEDDING_API_URL: "",
  EMBEDDING_API_KEY: "",
  // 嵌入提供方：空=按模型名判断（@cf/ 开头走 Workers AI），也可写 third-party / workers-ai
  EMBEDDING_PROVIDER: "",
  // 单次送进嵌入模型的字符数上限：Workers AI 的 bge-m3 最长 512 token，超了要先切块
  EMBEDDING_MAX_CHARS: "400",
  CF_API_BASE: "https://api.cloudflare.com/client/v4",
  DB_NAME: "rag-kb-db",
  INDEX_NAME: "rag-kb-index",
  EMBEDDING_MODEL: "text-embedding-3-small",
  EMBEDDING_DIMENSIONS: "1536",
  EMBEDDING_METRIC: "cosine",
  CHAT_MODEL: "gpt-4o-mini",
  CHAT_MAX_TOKENS: "1500",
  TOP_K: "6",
  CHUNK_MAX_CHARS: "600",
  CHUNK_OVERLAP_CHARS: "120",
  MAX_DOC_CHARS: "200000",
  MAX_CONTEXT_CHARS: "12000",
  FETCH_TIMEOUT_MS: "8000",
  FETCH_MAX_BYTES: "800000",
  ALLOW_PRIVATE_URLS: "false",
};

// 只有「没有这个变量」才用默认值；控制台显式设成空字符串算用户的选择
// （例如 API_KEY_PREFIX="" 表示平台要裸 Key，不加 Bearer 前缀）
export function withDefaults(env) {
  const merged = { ...DEFAULTS };
  for (const [key, value] of Object.entries(env || {})) {
    if (value === undefined || value === null) continue;
    merged[key] = value;
  }
  return merged;
}
