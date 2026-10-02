import { HttpError } from "./http.js";

// 检索用的词法信号：纯本地规则，不调模型，用来补上向量召回最容易漏掉的专有名词、数字与日期。
const LATIN_TOKEN = /[A-Za-z][A-Za-z0-9_.+-]{1,}|\d[\d.,]*/g;
const CJK = /[㐀-䶿一-鿿぀-ヿ]+/g;

// 中文没有空格分词，用连续两字（bigram）当检索单位：
// 「退货要几天内申请」→ 退货、要几、天内、申请…，原文只要有相同措辞就能命中
export function extractTerms(text, limit = 14) {
  const source = String(text ?? "");
  const terms = new Map();
  const push = (raw, weight) => {
    const clean = raw.replace(/[%_\\"'`;()（）[\]【】{}，。、；：！？,.;:!?“”‘’\s]+/g, "");
    if (clean.length < 2) return;
    const key = clean.toLowerCase();
    if (!terms.has(key) || terms.get(key) < weight) terms.set(key, weight);
  };

  for (const match of source.match(LATIN_TOKEN) ?? []) push(match, 2);
  for (const run of source.match(CJK) ?? []) {
    for (let i = 0; i + 2 <= run.length; i += 1) push(run.slice(i, i + 2), 1);
    if (run.length >= 3) push(run.slice(0, 3), 2);
    if (run.length >= 4) push(run.slice(0, 4), 3);
    if (run.length >= 6) push(run.slice(0, 6), 4);
  }
  // 长词更像专有名词，权重高；超出上限先丢最常见的双字
  return [...terms.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([term, weight]) => ({ term, weight }));
}

// 覆盖率：命中词的权重 ÷ 全部词权重，长词命中比短词命中更能说明相关
export function lexicalScore(terms, content) {
  if (!terms.length) return 0;
  const haystack = String(content ?? "").toLowerCase();
  let matched = 0;
  let total = 0;
  for (const { term, weight } of terms) {
    total += weight;
    if (haystack.includes(term)) matched += weight;
  }
  return total ? matched / total : 0;
}

export function likePattern(term) {
  // 转义 LIKE 的通配符，问题里的 % 与 _ 不能变成「匹配任意字符」
  return `%${String(term).replace(/[\\%_]/g, "\\$&")}%`;
}

export function keywordSql(terms, limit) {
  if (!terms.length) throw new HttpError(500, "关键词检索缺少检索词");
  const scored = terms.map(() => "(CASE WHEN content LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END)").join("\n    + ");
  const sql = `SELECT id, hits FROM (
  SELECT id,
    ${scored} AS hits
  FROM chunks
)
WHERE hits > 0
ORDER BY hits DESC, length(content) ASC
LIMIT ${Math.min(200, Number(limit) || 20)}`;
  return { sql, params: terms.map(({ term }) => likePattern(term)) };
}

// 两路分数都归一到 0–1，词法分权重更高：踩到提问里的具体数字、条款名才叫真的相关，
// 语义接近但一个关键词都没命中的片段只能算次选
export function combinedScore(vectorScore, lexical) {
  return 0.42 * Math.max(0, Math.min(1, vectorScore)) + 0.58 * lexical;
}

export function rankCandidates({ vectorHits, keywordHits, rows, terms, limit }) {
  const merged = new Map();
  for (const hit of vectorHits) merged.set(hit.id, { id: hit.id, vector: hit.score });
  for (const hit of keywordHits) if (merged.has(hit.id)) merged.get(hit.id).keyword = true;
  else merged.set(hit.id, { id: hit.id, vector: 0 });

  const ranked = [];
  for (const entry of merged.values()) {
    const row = rows.get(entry.id);
    if (!row) continue;
    const lexical = lexicalScore(terms, row.content);
    ranked.push({
      docId: row.doc_id,
      title: row.title,
      ordinal: Number(row.ordinal),
      content: row.content,
      score: combinedScore(entry.vector, lexical),
      vector: Number(entry.vector.toFixed(4)),
      lexical: Number(lexical.toFixed(3)),
    });
  }
  ranked.sort((a, b) => b.score - a.score || a.docId.localeCompare(b.docId) || a.ordinal - b.ordinal);
  // 既没踩到关键词、语义分也不高的片段直接丢掉，别把它们当「参考资料」喂给模型
  return ranked.filter((p) => p.lexical >= 0.12 || p.vector >= 0.45).slice(0, limit);
}

// 相邻切片带 overlap 字的重叠尾巴，两段同时被选中时会把同一句话喂两遍
export function stripOverlap(passages) {
  const byKey = new Map(passages.map((p) => [`${p.docId}:${p.ordinal}`, p]));
  for (const passage of passages) {
    const previous = byKey.get(`${passage.docId}:${passage.ordinal - 1}`);
    if (!previous) continue;
    const max = Math.min(previous.content.length, passage.content.length, 160);
    for (let size = max; size >= 12; size -= 1) {
      if (passage.content.startsWith(previous.content.slice(-size))) {
        passage.content = passage.content.slice(size).replace(/^[\s、，,；;。]+\s*/, "");
        break;
      }
    }
  }
  return passages.filter((p) => p.content.trim().length > 20);
}
