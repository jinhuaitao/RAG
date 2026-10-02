import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chunkText, detectHeading, extractText, normalizeText } from "../src/lib/chunk.js";
import { cleanText } from "../src/lib/clean.js";
import { encodeVector } from "../src/lib/cfapi.js";
import { assertPublicUrl, htmlToText } from "../src/lib/grab.js";
import { combinedScore, extractTerms, keywordSql, likePattern, lexicalScore, rankCandidates, stripOverlap } from "../src/lib/rank.js";

const cases = [];
function test(name, fn) {
  cases.push([name, fn]);
}

test("短文本只出一个片段", () => {
  const chunks = chunkText("Cloudflare Workers 是边缘运行时。", { maxChars: 600, overlap: 120 });
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0], "Cloudflare Workers 是边缘运行时。");
});

test("中文长段落按句子边界聚合且不超过上限", () => {
  const sentence = "退货申请需要在签收后七天内提交，逾期不再受理。";
  const text = Array.from({ length: 40 }, (_, i) => `${sentence}第 ${i} 条补充说明。`).join("");
  const chunks = chunkText(text, { maxChars: 300, overlap: 60 });
  assert.ok(chunks.length > 3, `期望切成多段，实际 ${chunks.length}`);
  for (const c of chunks) assert.ok(c.length <= 300, `片段超长 ${c.length}`);
});

test("相邻片段带尾部重叠，避免边界丢句", () => {
  const text = Array.from({ length: 30 }, (_, i) => `句子${i}内容。`).join("");
  const chunks = chunkText(text, { maxChars: 120, overlap: 40 });
  assert.ok(chunks.length >= 2);
  const tail = chunks[0].slice(-10);
  assert.ok(chunks[1].includes(tail), "第二段应包含第一段的尾部内容");
});

test("空输入与纯空白不产生片段", () => {
  assert.deepEqual(chunkText("", { maxChars: 600 }), []);
  assert.deepEqual(chunkText("   \n\n  \t \n", { maxChars: 600 }), []);
});

test("归一化多余空行与 CRLF", () => {
  assert.equal(normalizeText("a\r\n\r\n\r\n\r\nb  \r\n"), "a\n\nb");
});

test("HTML 抽取正文并丢弃脚本样式", () => {
  const text = extractText("page.html", "<html><head><style>p{color:red}</style><script>alert(1)</script></head><body><h1>标题</h1><p>正文内容</p></body></html>");
  assert.ok(text.includes("正文内容"));
  assert.ok(!text.includes("alert"));
  assert.ok(!text.includes("color:red"));
});

test("向量压到 6 位小数并保持维度", () => {
  const raw = Array.from({ length: 1024 }, (_, i) => Math.sin(i) / 3);
  const out = encodeVector(raw);
  assert.equal(out.length, 1024);
  assert.equal(out[1], Number((Math.sin(1) / 3).toFixed(6)));
  assert.ok(out.every((value) => typeof value === "number"));
});

test("TypedArray 与含 NaN 的向量按边界处理", () => {
  assert.deepEqual(encodeVector(new Float32Array([0.1, -0.25, 1 / 3])), [0.1, -0.25, 0.333333]);
  assert.throws(() => encodeVector([0.1, NaN]), /不是有限数字/);
  assert.throws(() => encodeVector([]), /空向量/);
});

test("1024 维 query 请求体体积可控且是合法 JSON", () => {
  const raw = Array.from({ length: 1024 }, (_, i) => (Math.sin(i * 12.9898) * 43758.5453) % 1);
  const full = JSON.stringify({ vector: raw, topK: 6, returnMetadata: false });
  const compact = JSON.stringify({ topK: 6, vector: encodeVector(raw) });
  assert.deepEqual(JSON.parse(compact).vector[0], encodeVector(raw)[0]);
  assert.ok(compact.length < full.length, "压缩后应更小");
  assert.ok(compact.length < 12_000, `请求体应远小于出问题时的 19478 字节，实际 ${compact.length}`);
});

test("清洗：去掉导航、页码、目录点线与页脚噪声", () => {
  const { text, stats } = cleanText(
    [
      "某某科技官网 > 帮助中心 > 开票说明",
      "返回顶部",
      "分享        收藏        点赞",
      "© 2026 某某科技 保留所有权利",
      "第 3 页",
      "第一章 总则………… 12",
      "电子发票在订单完成后 24 小时内开具。",
    ].join("\n")
  );
  assert.equal(text, "电子发票在订单完成后 24 小时内开具。");
  assert.ok(stats.droppedLines >= 5, `应删掉至少 5 行噪声，实际 ${stats.droppedLines}`);
});

test("清洗：合并被排版硬断开的中文行，英文断词去掉连字符", () => {
  const { text, stats } = cleanText("发票抬头一经开具不支持修改，如需变更请先作废原\n票再重新申请。\nThis is an exam-\nple of hyphenation.");
  assert.equal(text, "发票抬头一经开具不支持修改，如需变更请先作废原票再重新申请。\n\nThis is an example of hyphenation.");
  assert.ok(stats.mergedLines >= 2);
});

test("清洗：正文里出现噪声词不会被误删", () => {
  const prose = "本文件版权所有，未经授权不得转发。员工可在设置里开启分享功能，登录后扫码绑定企业微信。";
  assert.equal(cleanText(prose).text, prose);
});

test("清洗：跨页重复页眉只出现一次的内容保留、重复三次的删掉", () => {
  const body = [
    "某某集团财务制度汇编",
    "第一条 报销需在当月提交。",
    "某某集团财务制度汇编",
    "第二条 差旅住宿按职级限额。",
    "某某集团财务制度汇编",
    "第三条 发票缺失需书面说明。",
  ].join("\n");
  const { text } = cleanText(body);
  assert.ok(!text.includes("财务制度汇编"), "重复页眉应被删除");
  assert.ok(text.includes("第二条"), "正文不得被牵连删除");
});

test("清洗：markdown 链接与图片只留文字，表格分隔行去掉", () => {
  const { text } = cleanText("详见[开票指南](https://example.com/a)。\n![示意图](/i.png)\n| 类型 | 时效 |\n| --- | --- |\n| 电子票 | 24h |");
  assert.ok(text.includes("详见开票指南。"));
  assert.ok(!text.includes("https://"));
  assert.ok(!text.includes("---"));
  assert.ok(text.includes("| 电子票 | 24h |"));
});

test("切片：每个片段注入所属章节路径，跨章节不重叠", () => {
  const doc = [
    "# 发票开具",
    "",
    "电子发票在订单完成后 24 小时内开具，可在我的订单页面自助下载打印，与纸质发票具有同等法律效力，" +
      "支持重复下载与转发给财务同事，红冲后原票会自动作废并重新生成新的票据。",
    "",
    "# 合同用印",
    "",
    "合同金额超过 50 万元需要法务部会签，一般合同在两个工作日内完成用印处理，" +
      "紧急件可由部门负责人加急申请并同步电子合同链接。",
  ].join("\n");
  const chunks = chunkText(doc, { maxChars: 120, overlap: 40 });
  assert.ok(chunks.length >= 2, `期望至少两段，实际 ${chunks.length}`);
  assert.ok(chunks[0].startsWith("【发票开具】"), chunks[0]);
  const contract = chunks.find((chunk) => chunk.includes("法务部"));
  assert.ok(contract.startsWith("【合同用印】"), `章节路径应切换：${contract}`);
  assert.ok(!contract.includes("我的订单"), "跨章节不应带上上一章的重叠内容");
});

test("标题识别覆盖 markdown、中文序号与十进制编号", () => {
  assert.equal(detectHeading("# 发票开具").level, 1);
  assert.equal(detectHeading("第三条 适用范围").title, "第三条 适用范围");
  assert.equal(detectHeading("2.1 开票时效").level, 2);
  assert.equal(detectHeading("本段落落在这里。"), null);
});

const BLOCKED_URLS = [
  "http://localhost:8788/x",
  "http://127.0.0.1/",
  "http://0.0.0.0/",
  "http://10.1.2.3/",
  "http://172.16.0.1/",
  "http://192.168.1.1/",
  "http://100.64.0.1/",
  "http://169.254.169.254/latest/meta-data/",
  "http://0x7f000001/",
  "http://127.1/",
  "http://[::1]/",
  "http://[fd00::1]/",
  "http://[fe80::1%eth0]/",
  "http://[2001:0::1]/",
  "http://[2002:7f00:1::]/",
  "http://[::ffff:192.168.0.1]/",
  "http://intranet.local/",
  "http://svc.internal/",
  "https://admin:p@ssw0rd@example.com/doc",
  "ftp://example.com/doc",
  "javascript:alert(1)",
  "不是一个网址",
];

test("网址抓取：内网、保留地址与非法协议一律拒绝", () => {
  for (const url of BLOCKED_URLS) {
    assert.throws(() => assertPublicUrl(url, {}), (error) => error.status === 400, `应被拒绝：${url}`);
  }
});

test("网址抓取：公网地址放行，内网开关只影响本机", () => {
  for (const url of ["https://example.com/docs", "https://example.com:8443/x?y=1#z", "http://93.184.216.34/", "https://[2606:2800::1]/"]) {
    assert.ok(assertPublicUrl(url, {}).hostname, `应放行：${url}`);
  }
  assert.equal(assertPublicUrl("http://127.0.0.1:8790/x", { ALLOW_PRIVATE_URLS: "true" }).hostname, "127.0.0.1");
  // 开关只放开内网调试，元数据/链路本地/组播地址永远拒绝
  const allowPrivate = { ALLOW_PRIVATE_URLS: "true" };
  for (const url of ["http://169.254.169.254/latest/meta-data/", "http://0.0.0.0/", "http://[fe80::1]/", "http://[ff02::1]/"]) {
    assert.throws(() => assertPublicUrl(url, allowPrivate), (error) => error.status === 400, `开关下仍应拒绝：${url}`);
  }
});

const SAMPLE_PAGE = readFileSync(new URL("../fixtures/return-policy.html", import.meta.url), "utf8");

test("网址抓取：只取正文，去掉脚本、导航、页脚并还原结构", () => {
  const text = htmlToText(SAMPLE_PAGE);
  assert.ok(text.includes("## 一、退货条件"), text.slice(0, 200));
  assert.ok(text.includes("- 定制类商品不支持七天无理由退货"), "列表项应带 - 前缀");
  assert.ok(text.includes("银行卡 | 3–5 个工作日"), `表格应转成分隔文本：${text}`);
  for (const junk of ["tracking", "不应进入正文", "footerLinks", "首页 > 帮助中心", "登录 注册", "分享 收藏", "Copyright"]) {
    assert.ok(!text.includes(junk), `不应保留噪声内容：${junk}`);
  }
  assert.ok(!text.includes("&") && !text.includes("<"), `实体与标签应已还原：${text}`);
});

test("网址抓取：网页正文经清洗与切片后可正常检索", () => {
  const cleaned = cleanText(htmlToText(SAMPLE_PAGE));
  assert.ok(cleaned.text.includes("退货申请需要在签收后七天内提交，逾期不再受理。"), "被硬断开的行应被合并");
  assert.ok(!cleaned.text.includes("示例商店"), "站名等重复行应被去掉");
  const chunks = chunkText(cleaned.text, { maxChars: 600, overlap: 120 });
  assert.ok(chunks.length >= 1);
  assert.ok(cleaned.text.includes("## 二、退款到账"), "标题应还原成 markdown 层级，供切片注入章节路径");
  assert.ok(cleaned.text.includes("银行卡 | 3–5 个工作日"), cleaned.text);
});

test("网址抓取：非 HTML 文本按原样保留", () => {
  assert.equal(htmlToText("纯文本，没有标签。"), "纯文本，没有标签。");
});

test("检索：中文按双字取词，长词权重更高，英文与数字单独成词", () => {
  const terms = extractTerms("退货申请需要在几天内提交？refund 要 3-5 工作日");
  const byTerm = new Map(terms.map((entry) => [entry.term, entry.weight]));
  assert.ok(byTerm.has("退货") && byTerm.has("申请"), [...byTerm.keys()].join(","));
  assert.ok(byTerm.get("退货申请") > byTerm.get("退货"), "长词权重应更高");
  assert.equal(byTerm.get("refund"), 2);
  assert.ok(byTerm.has("3-5") || byTerm.has("3"), "数字要参与检索");
  assert.ok(![...byTerm.keys()].some((term) => term.includes("？")), "标点不进检索词");
});

test("检索：关键词覆盖率区分「踩中原文」与「只是话题相近」", () => {
  const terms = extractTerms("退款到账要几个工作日");
  const exact = lexicalScore(terms, "退款到账时间取决于发卡银行，通常为 3–5 个工作日。");
  const vague = lexicalScore(terms, "我们的售后体系完善，客户满意度长期保持在行业领先水平。");
  assert.ok(exact > vague * 2, `exact=${exact} vague=${vague}`);
  assert.ok(vague < 0.2, vague);
});

test("检索：LIKE 模式转义通配符，查询只走占位符", () => {
  assert.equal(likePattern("50%_off"), "%50\\%\\_off%");
  const { sql, params } = keywordSql(extractTerms("折扣 30% 与 A_B 型号的退货流程"), 24);
  assert.equal((sql.match(/\?/g) || []).length, params.length, "占位符数量要与参数一致");
  assert.ok(params.every((p) => p.startsWith("%") && p.endsWith("%")));
  assert.ok(!params.some((p) => p.includes("'") || p.includes(";")), params.join("|"));
  assert.ok(sql.includes("ESCAPE '\\'") && sql.includes("LIMIT 24"), sql);
});

test("检索：向量与关键词合并重排，弱相关片段被挡在门外", () => {
  const terms = extractTerms("发票开错的作废重开流程");
  const rows = new Map([
    ["a-1", { id: "a-1", doc_id: "a", title: "财务手册", ordinal: 1, content: "发票开错需要作废重开，先提交作废申请再由税务岗开票。" }],
    ["a-2", { id: "a-2", doc_id: "a", title: "财务手册", ordinal: 2, content: "公司一贯重视财务合规，报销单据需leader签字。" }],
    ["b-9", { id: "b-9", doc_id: "b", title: "团建通知", ordinal: 9, content: "本周六爬山，请穿运动鞋。" }],
  ]);
  const ranked = rankCandidates({
    vectorHits: [
      { id: "a-2", score: 0.8 },
      { id: "a-1", score: 0.72 },
      { id: "b-9", score: 0.6 },
    ],
    keywordHits: [{ id: "a-1", hits: 4 }],
    rows,
    terms,
    limit: 6,
  });
  assert.equal(ranked[0].docId + ":" + ranked[0].ordinal, "a:1", "踩中关键词的片段应排在只话题相近的前面");
  assert.ok(ranked.every((p) => !(p.docId === "b" && p.lexical < 0.12 && p.vector < 0.45)), "语义一般又零关键词命中的不该进上下文");
  assert.ok(combinedScore(0.3, 0.9) > combinedScore(0.75, 0), "关键词权重要高于语义分");
});

test("检索：同篇相邻片段的重叠尾巴不再重复喂给模型", () => {
  const passages = [
    { docId: "a", ordinal: 1, title: "手册", content: "第一段内容，讲的是开票时效与作废规则，结尾在此", score: 0.9, lexical: 0.5 },
    { docId: "a", ordinal: 2, title: "手册", content: "开票时效与作废规则，结尾在此\n第二段内容，讲的是红字确认单，长度足够不被过滤掉。", score: 0.8, lexical: 0.4 },
  ];
  const stripped = stripOverlap(passages);
  assert.equal(stripped.length, 2);
  assert.ok(!stripped[1].content.startsWith("开票时效"), stripped[1].content);
  assert.ok(stripped[1].content.includes("红字确认单"));
});

test("检索：命中专有名词的片段不会被一堆双字词稀释掉", () => {
  const terms = extractTerms("请问一下我们公司的红字确认单在跨月的情況下要怎么处理才能正常开票呢");
  const core = keywordTerms(terms);
  assert.ok(core.length && core.every((entry) => entry.weight >= 2), "关键词召回只用稀有词");
  assert.deepEqual(keywordTerms(extractTerms("退货 政策")).every((entry) => entry.weight >= 2), true);
  const hit = "跨月的红字确认单需要税务岗先在系统里作废，再重新开票。";
  const miss = "我们公司一直提倡大家及时开票，财务同事会很乐意协助处理相关事宜。";
  assert.ok(overlapScore(terms, core, hit) > overlapScore(terms, core, miss) + 0.15, `${overlapScore(terms, core, hit)} vs ${overlapScore(terms, core, miss)}`);
});

let failed = 0;
for (const [name, fn] of cases) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`✗ ${name}\n  ${error.message}`);
  }
}
console.log(`\n${cases.length - failed}/${cases.length} 通过`);
process.exit(failed ? 1 : 0);
