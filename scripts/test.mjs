import assert from "node:assert/strict";
import { chunkText, extractText, normalizeText } from "../src/lib/chunk.js";

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
