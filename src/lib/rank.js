import { HttpError } from "./http.js";

// 检索用的词法信号：纯本地规则，不调模型，用来补上向量召回最容易漏掉的专有名词、数字与日期。
// 提问里的疑问词、助词和客套话几乎不会出现在文档里，先把它们当分隔符，
// 剩下的连续中文才当成「短语」去关键词召回。
// 单字虚词用前后瞻保护真词：了(?!解) 保住了解，在(?!线) 保住在线，(?<!员)会 保住委员会。
// 「请」只做多字词（请问、请教）：它出现在「申请」词尾，任何单字规则都会把申请切坏
const FILLER =
  /请问|请教|想问|烦请|一下|是不是|是否|哪些|哪个|哪种|什么|怎么办|怎么|怎样|如何|多少|几点|几天|需要|可以|能不能|可不可以|应该|必须|我们|你们|他们|公司|没有|还能|还是|以及|或者|如果|因为|然后|的话|的|了(?!解)|是|在(?!线)|要(?!求|件)|(?<![员工])会(?!计|议|签)|没|再|吗|呢|吧|啊|呀|哦|啦|和/g;
const LATIN_TOKEN = /[A-Za-z][A-Za-z0-9_.+-]+|\d+(?:[.,\-–~至]\d+)*/g;
const CJK = /[㐀-䶿一-鿿぀-ヿ]+/g;

// 检索单位分三层：整段短语（最稀有）、三字窗（中文最常见词长，长短语匹配不上时靠它定位）、
// 双字（保召回）。权重差就是「踩中专有名词」与「只是话题相近」的差
export function extractTerms(text, limit = 60) {
  const source = String(text ?? "").replace(FILLER, " ");
  const terms = new Map();
  const push = (raw, weight) => {
    const clean = raw.replace(/[%_\\"'`;()（）[\]【】{}，。、；：！？,.;:!?“”‘’\s]+/g, "");
    if (clean.length < 2) return;
    const key = clean.toLowerCase();
    if (!terms.has(key) || terms.get(key) < weight) terms.set(key, weight);
  };

  for (const match of source.match(LATIN_TOKEN) ?? []) push(match, 4);
  for (const run of source.match(CJK) ?? []) {
    if (run.length <= 8) push(run, 5);
    if (run.length >= 3) for (let i = 0; i + 3 <= run.length; i += 1) push(run.slice(i, i + 3), 4);
    for (let i = 0; i + 2 <= run.length; i += 1) push(run.slice(i, i + 2), 2);
  }
  // 稀有词优先：截断时宁可丢掉双字，也不能把短语切没
  return [...terms.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([term, weight]) => ({ term, weight }));
}

// 只拿短语、三字窗和英文数字去做 LIKE 全表扫描：双字太常见，拿去扫库会把一堆无关片段捞进来
export function keywordTerms(terms, limit = 10) {
  const picked = terms.filter((entry) => entry.weight >= 4);
  return (picked.length ? picked : terms).slice(0, limit);
}

// 覆盖率：命中词的权重 ÷ 全部词权重。长问题里双字词很多，只按全量算会把
// 「踩中了专有名词」的片段淹掉，所以再单独算一遍稀有词的覆盖率取较大值
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

export function overlapScore(terms, coreTerms, content) {
  const all = lexicalScore(terms, content);
  const core = coreTerms.length ? lexicalScore(coreTerms, content) * 0.8 : 0;
  return Math.max(all, core);
}

export function likePattern(term) {
  // 转义 LIKE 的通配符，问题里的 % 与 _ 不能变成「匹配任意字符」
  return `%${String(term).replace(/[\\%_]/g, "\\$&")}%`;
}

export function keywordSql(terms, limit) {
  if (!terms.length) throw new HttpError(500, "关键词检索缺少检索词");
  const scored = terms.map(() => "(CASE WHEN content LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END)").join("\n    + ");
  // 短片段信息密度高，命中数相同时优先；len 在外层算就查不到 content 了，必须在子查询里算好
  const sql = `SELECT id, hits FROM (
  SELECT id,
    ${scored} AS hits,
    length(content) AS len
  FROM chunks
)
WHERE hits > 0
ORDER BY hits DESC, len ASC
LIMIT ${Math.min(200, Number(limit) || 20)}`;
  return { sql, params: terms.map(({ term }) => likePattern(term)) };
}

// 两路分数都归一到 0–1，词法分权重更高：踩到提问里的具体数字、条款名才叫真的相关，
// 语义接近但一个关键词都没命中的片段只能算次选
export function combinedScore(vectorScore, lexical) {
  return 0.42 * Math.max(0, Math.min(1, vectorScore)) + 0.58 * lexical;
}

export function rankCandidates({ vectorHits, keywordHits, rows, terms, coreTerms = terms, limit }) {
  const merged = new Map();
  for (const hit of vectorHits) merged.set(hit.id, { id: hit.id, vector: hit.score });
  // 关键词这一路的价值是把向量漏掉的片段带进候选池，分数仍由覆盖率决定
  for (const hit of keywordHits) if (!merged.has(hit.id)) merged.set(hit.id, { id: hit.id, vector: 0 });

  const ranked = [];
  for (const entry of merged.values()) {
    const row = rows.get(entry.id);
    if (!row) continue;
    const lexical = overlapScore(terms, coreTerms, row.content);
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
