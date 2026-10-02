import { HttpError } from "./http.js";

const SYSTEM_PROMPT = `你是一个严格依据知识库回答的助手。
规则：
1. 只使用【参考资料】中的信息作答，禁止用你自己的知识补充事实。
2. 每一处引用事实都在句末标注来源编号，例如 [1]、[2]。
3. 参考资料无法回答时，直接回答“知识库中没有相关信息”，并说明缺少哪部分信息，不要编造。
4. 资料之间存在冲突时，指出冲突并分别给出编号来源。
5. 用与提问相同的语言回答，条理清晰，控制在 500 字以内。`;

function buildContext(passages, maxChars) {
  let used = 0;
  const picked = [];
  for (const passage of passages) {
    if (used + passage.content.length > maxChars && picked.length >= 2) break;
    picked.push(passage);
    used += passage.content.length;
  }
  return picked.map((p, i) => `【${i + 1}】《${p.title}》\n${p.content}`).join("\n\n---\n\n");
}

export async function generateAnswer(env, { question, passages }) {
  if (!passages.length) {
    return {
      answer: "知识库中没有相关信息。请先在“知识库管理”里上传或粘贴文档，再来提问。",
      used: [],
      empty: true,
    };
  }
  const context = buildContext(passages, Number(env.MAX_CONTEXT_CHARS) || 12_000);
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `【参考资料】\n${context}\n\n【问题】\n${question}` },
  ];

  let response;
  try {
    response = await env.AI.run(env.CHAT_MODEL, { messages, temperature: 0.2, max_tokens: 900 });
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
    if (/model|not found|invalid/i.test(message)) {
      throw new HttpError(500, `生成模型 ${env.CHAT_MODEL} 调用失败：${message}`, {
        hint: `登录账号后运行 npx wrangler ai models list 查看当前可用的 Text Generation 模型，把 wrangler.jsonc 里的 CHAT_MODEL 换成新的 ID（无需改代码）`,
      });
    }
    throw new HttpError(502, `生成模型调用失败：${message}`);
  }

  const answer = response?.response ?? response?.result?.response;
  if (typeof answer !== "string") {
    throw new HttpError(502, `生成模型 ${env.CHAT_MODEL} 返回格式异常`, { raw: JSON.stringify(response).slice(0, 400) });
  }
  return { answer, used: passages.map((p, i) => ({ index: i + 1, title: p.title, docId: p.docId, score: p.score, ordinal: p.ordinal })) };
}
