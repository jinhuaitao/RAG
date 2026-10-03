import { HttpError } from "./http.js";

const SYSTEM_PROMPT = `你是一个严格依据知识库回答的助手。
规则：
1. 只使用【参考资料】中的信息作答，禁止用你自己的知识补充事实。
2. 资料里没有出现过的数字、日期、金额、名称、条款号，一个字都不许写。
3. 每一处引用事实都在句末标注来源编号，例如 [1]、[2]。
4. 参考资料无法回答时，直接回答“知识库中没有相关信息”，并说明缺少哪部分信息，不要编造、不要猜测。
5. 资料之间存在冲突时，指出冲突并分别给出编号来源。
6. 用与提问相同的语言回答，条理清晰，控制在 500 字以内。`;

// 同一篇文档的多个片段并成一个来源块：编号对应文档而不是片段，
// 免得模型把同一段内容当成两条互相印证的独立证据
function groupByDocument(passages) {
  const groups = new Map();
  for (const passage of passages) {
    if (!groups.has(passage.docId)) groups.set(passage.docId, []);
    groups.get(passage.docId).push(passage);
  }
  return [...groups.values()]
    .map((items) => items.sort((a, b) => a.ordinal - b.ordinal))
    .sort((a, b) => b[0].score - a[0].score);
}

function buildContext(groups, maxChars) {
  let used = 0;
  const kept = [];
  for (const group of groups) {
    const passages = [];
    for (const passage of group) {
      if (used + passage.content.length > maxChars && kept.length + passages.length >= 1) break;
      passages.push(passage);
      used += passage.content.length;
    }
    if (passages.length) kept.push(passages);
    if (used >= maxChars) break;
  }
  const text = kept
    .map(
      (passages, i) =>
        `【${i + 1}】《${passages[0].title}》（片段 ${passages.map((p) => p.ordinal + 1).join("、")}）\n${passages.map((p) => p.content).join("\n\n")}`
    )
    .join("\n\n---\n\n");
  return { blocks: kept, text };
}

export async function generateAnswer(env, { question, passages, terms = [] }) {
  if (!passages.length) {
    return {
      answer: "知识库中没有相关信息。请先在“知识库管理”里上传或粘贴文档，再来提问。",
      used: [],
      empty: true,
    };
  }
  const maxChars = Number(env.MAX_CONTEXT_CHARS) || 12_000;
  const { blocks, text } = buildContext(groupByDocument(passages), maxChars);
  // 重点词只给稀有词（短语与数字），全量双字会让模型把「工作」「提交」当成答题线索
  const rare = terms.filter((entry) => entry.weight >= 4).slice(0, 8);
  const focus = rare.length ? `\n【重点词】${rare.map((entry) => entry.term).join("、")}` : "";
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `【参考资料】\n${text}\n\n【问题】\n${question}${focus}` },
  ];

  let response;
  const maxTokens = Math.min(4096, Number(env.CHAT_MAX_TOKENS) || 900);
  try {
    response = await env.AI.run(env.CHAT_MODEL, { messages, temperature: 0.2, max_tokens: maxTokens });
  } catch (error) {
    const message = String(error?.message ?? error);
    if (/deprecat/i.test(message)) {
      throw new HttpError(500, `生成模型 ${env.CHAT_MODEL} 已下线：${message}`, {
        hint: [
          "Workers AI 会定期下线旧模型，换一个仍然在架的 ID 即可，不需要改代码",
          "同架构的替代 ID 通常是在模型名后加量化后缀，例如 @cf/meta/llama-3.1-8b-instruct 对应 @cf/meta/llama-3.1-8b-instruct-fp8",
          "可选清单：https://developers.cloudflare.com/workers-ai/models/ 里筛 Text Generation",
          "改 wrangler.jsonc 的 CHAT_MODEL 后提交到 GitHub，控制台会自动重新部署",
        ],
      });
    }
    // Workers AI 按每个模型自己的 JSON Schema 校验请求体：completion 系的老模型只有 prompt 分支，
    // 发 messages 就会撞到 oneOf，这里直接把「换了哪个字段」说清楚
    if (/oneOf|not met|required properties|schema/i.test(message)) {
      throw new HttpError(500, `生成模型 ${env.CHAT_MODEL} 不接受 messages 请求体：${message}`, {
        hint: [
          "本 Worker 用 env.AI.run 发送 { messages, temperature, max_tokens }，要求模型的 schema 里有 messages 分支",
          "只认 prompt 的是 completion 时代的老模型（例如 @cf/meta/llama-3.2-3b-instruct、llama-2 系列），换一个对话模型即可，不用改代码",
          "在控制台 Workers AI → 模型页用同样的 messages 试跑一次，能跑通的 ID 就能直接用",
          "在架清单：https://developers.cloudflare.com/workers-ai/models/ 里筛 Text Generation",
        ],
      });
    }
    if (/model|not found|invalid/i.test(message)) {
      throw new HttpError(500, `生成模型 ${env.CHAT_MODEL} 调用失败：${message}`, {
        hint: `登录账号后运行 npx wrangler ai models list 查看当前可用的 Text Generation 模型，把 wrangler.jsonc 里的 CHAT_MODEL 换成新的 ID（无需改代码）`,
      });
    }
    throw new HttpError(502, `生成模型调用失败：${message}`);
  }

  const raw = response?.response ?? response?.result?.response ?? response?.reasoning_content ?? response?.result?.reasoning_content;
  if (typeof raw !== "string" || !raw.trim()) {
    throw new HttpError(502, `生成模型 ${env.CHAT_MODEL} 返回格式异常`, { raw: JSON.stringify(response).slice(0, 400) });
  }
  // 推理模型把思考过程混在正文里返回：Cloudflare 的输出结构没有单独的 reasoning 字段，
  // 只能在文本里找思考块标记（拼出来是为了避开标签字面量被工具层吃掉），取结束标记之后的部分当答案
  const open = ["<", "think", ">"].join("");
  const close = ["<", "/", "think", ">"].join("");
  const end = raw.lastIndexOf(close);
  if (end < 0 && raw.includes(open)) {
    throw new HttpError(502, `生成模型 ${env.CHAT_MODEL} 的思考过程没写完就被截断，正文为空`, {
      hint: [
        "思考过程的 token 也算在 CHAT_MAX_TOKENS 里，当前配置是 " + maxTokens,
        "把 wrangler.jsonc 的 CHAT_MAX_TOKENS 调到 2500–3000 再部署试试（无需改代码）",
        "提示里已限制 500 字，但思考长度仍由模型自己决定",
      ],
    });
  }
  const answer = (end < 0 ? raw : raw.slice(end + close.length).replace(/^[\s:：]+/, "")).trim();
  if (!answer) {
    throw new HttpError(502, `生成模型 ${env.CHAT_MODEL} 的思考过程之后没有正文`, { hint: `调大 wrangler.jsonc 的 CHAT_MAX_TOKENS（当前 ${maxTokens}）后重试` });
  }
  const used = blocks.map((group, index) => ({
    index: index + 1,
    docId: group[0].docId,
    title: group[0].title,
    chunks: group.map((p) => p.ordinal + 1),
    score: group[0].score,
    vector: Math.max(...group.map((p) => p.vector)),
    lexical: Math.max(...group.map((p) => p.lexical)),
    excerpt: group.map((p) => p.content).join("\n").slice(0, 300),
  }));
  return { answer, used };
}
