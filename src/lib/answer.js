import { HttpError } from "./http.js";
import { chatCompletion } from "./llm.js";

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

  const maxTokens = Math.min(4096, Number(env.CHAT_MAX_TOKENS) || 900);
  const result = await chatCompletion(env, { messages, temperature: 0.2, maxTokens });
  const answer = result.content.trim();
  if (!answer) {
    throw new HttpError(502, `生成模型 ${env.CHAT_MODEL} 没有返回正文`, {
      hint: `调大控制台变量 CHAT_MAX_TOKENS（当前 ${maxTokens}）后重试`,
    });
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
  return { answer, used, usage: result.usage, model: result.model };
}
